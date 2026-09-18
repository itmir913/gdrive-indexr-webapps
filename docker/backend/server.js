require('dotenv').config();

const fs = require('fs');
const express = require('express');
const { google } = require('googleapis');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const crypto = require('crypto');
const { runSearch, extractKeywords } = require('./search-pipeline');
const { normalizeKeyword, buildSearchIndex, matchKeyword } = require('./search-keys');
const { tokenize, BooleanParser } = require('./parser');

const app = express();
app.use(express.json());

const PORT              = process.env.PORT || 3000;
const FOLDER_ID         = process.env.FOLDER_ID;
const ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost/oauth/callback';
// [fix-13.1] 크론·로그·날짜 계산이 모두 같은 시간대를 쓰도록 단일 상수로 관리.
//            미지정 시 node-cron·Date는 프로세스 로컬(컨테이너 기본 UTC)을 쓴다.
const TIMEZONE          = process.env.TZ || 'Asia/Seoul';
const PRECACHE_TOP_N    = 100;
const PURGE_AFTER_DAYS  = 3;                // 미검색 키워드 삭제 기준
const CACHE_TTL_MS      = 6 * 60 * 60 * 1000;
const WARM_CACHE_LIMIT_MS = 4 * 60 * 1000;
const RETRY_COUNT       = 3;
const RETRY_DELAY_MS    = 500;
// [fix-13.14] /api/search는 무인증이고 캐시 미스 키워드마다 Drive를 호출한다.
// [fix-13.B6] 상한 대상은 '요청 수'가 아니라 'Drive 호출 수'다. 요청 수를 세면 캐시로만
//             처리되는 정상 검색까지 막혀 회의 시간에 전원이 429를 본다.
//             nginx 뒤라 클라이언트 IP가 구분되지 않아 전역으로 둔다.
const DRIVE_CALL_BUDGET      = 200;         // 창당 허용 Drive API 호출 수
const DRIVE_BUDGET_WINDOW_MS = 60 * 1000;

const CREDENTIALS_PATH = '/app/data/credentials.json';
const TOKEN_PATH       = '/app/data/token.json';

const db = new sqlite3.Database('/app/data/database.sqlite');
let fileIndexCache = new Map();
let searchIndex = [];   // [{ id, nameKey, pathKey }] — 정규화된 검색 키 (응답에 포함되지 않음)
let isIndexing = false;
let isWarmingCache = false;
// [fix-13.9] 인덱스 교체 세대. 재빌드 확정 시 증가하며, 진행 중 계산된 결과가
//            교체 이후에 캐시로 기록되는 것을 막는다.
let indexGeneration = 0;
// [fix-13.B2] 3번(빈 인덱스 커밋 차단)과 4번(403에 토큰 삭제 안 함)을 함께 고친 결과,
//             refresh token 폐기나 영구 403이 아무 흔적도 남기지 않게 됐다. 예전에는
//             원인은 틀렸어도 "미인증"이 화면에 보였다. 마지막 재빌드 결과와 마지막
//             Drive 오류를 health로 노출해 관리자가 알 수 있게 한다.
let lastRebuild  = { at: null, result: null, message: null };
let lastDriveError = { at: null, message: null };
let rebuildNote = null;   // 이번 재빌드가 남긴 사유 (래퍼가 lastRebuild로 옮긴다)
// [fix-13.B4] 색인 시점의 루트 폴더 이름. 경로에서 루트 세그먼트를 정확히 떼는 데 쓴다.
let rootFolderName = '';

// ── 로거 ─────────────────────────────────────────────────────────────────────
const ts = () => new Date().toLocaleString('sv-SE', { timeZone: TIMEZONE });
// [fix-13.1] 크론이 TIMEZONE 기준으로 도는데 날짜 경계만 UTC면 purge가 어긋난다
const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
const log = {
    info:  (tag, msg) => console.log(`[${ts()}]\t[INFO ]\t[${tag.padEnd(9)}]\t${msg}`),
    warn:  (tag, msg) => console.warn(`[${ts()}]\t[WARN ]\t[${tag.padEnd(9)}]\t${msg}`),
    error: (tag, msg) => console.error(`[${ts()}]\t[ERROR]\t[${tag.padEnd(9)}]\t${msg}`),
};

function noteDriveError(message) {
    lastDriveError = { at: ts(), message: String(message ?? '').slice(0, 300) };
}

// ── DB 초기화 ────────────────────────────────────────────────────────────────
// [fix-D] DDL에 트랜잭션 불필요 — serialize 큐 내 콜백에서 ROLLBACK이 COMMIT 이후 실행되는
//         패턴 버그를 제거하고, 마지막 CREATE TABLE 콜백에서 resolve로 단순화
function initDB() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS file_index (
                    fileId     TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    path       TEXT NOT NULL,
                    url        TEXT NOT NULL,
                    modifiedAt TEXT
                )
            `, (err) => { if (err) return reject(err); });
            db.run(`
                CREATE TABLE IF NOT EXISTS keyword_log (
                    keyword       TEXT PRIMARY KEY,
                    count         INTEGER DEFAULT 1,
                    lastSearchDay TEXT
                )
            `, (err) => { if (err) return reject(err); });
            db.run(`
                CREATE TABLE IF NOT EXISTS keyword_cache (
                    keyword  TEXT PRIMARY KEY,
                    fileIds  TEXT NOT NULL,
                    cachedAt INTEGER NOT NULL
                )
            `, (err) => { if (err) return reject(err); });
            // [fix-13.B4] 루트 폴더 이름 보관용. CREATE TABLE IF NOT EXISTS라
            //             기존 DB에도 그대로 붙으며 마이그레이션이 필요 없다.
            db.run(`
                CREATE TABLE IF NOT EXISTS app_meta (
                    key   TEXT PRIMARY KEY,
                    value TEXT
                )
            `, (err) => {
                if (err) return reject(err);
                log.info('DB', '스키마 초기화 완료');
                resolve();
            });
        });
    });
}

// ── OAuth 인증 ───────────────────────────────────────────────────────────────
function isAuthenticated() {
    if (!fs.existsSync(TOKEN_PATH)) return false;
    try {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
        // refresh_token이 있으면 만료돼도 자동 갱신 가능
        if (token.refresh_token) return true;
        // [fix-E14] expiry_date 없는 토큰은 만료로 간주 (이전: 무조건 true 반환)
        if (!token.expiry_date) return false;
        if (token.expiry_date < Date.now()) return false;
        return true;
    } catch {
        return false;
    }
}

function clearToken() {
    if (fs.existsSync(TOKEN_PATH)) {
        fs.unlinkSync(TOKEN_PATH);
        log.warn('Auth', 'token.json 삭제 — 재인증 필요');
    }
}

function getOAuthClient() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_secret, client_id } = credentials.installed || credentials.web;
    return new google.auth.OAuth2(client_id, client_secret, OAUTH_REDIRECT_URI);
}

function getDriveClient() {
    const oAuth2Client = getOAuthClient();
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);

    oAuth2Client.on('tokens', (tokens) => {
        const current = JSON.parse(fs.readFileSync(TOKEN_PATH));
        fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }, null, 2));
        log.info('Auth', 'access_token 갱신 완료');
    });

    return google.drive({ version: 'v3', auth: oAuth2Client });
}

// ── 재시도 헬퍼 (지수 백오프) ─────────────────────────────────────────────────
async function withRetry(fn, retries = RETRY_COUNT, delay = RETRY_DELAY_MS) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e) {
            const status = e.status || e.code || e.response?.status;
            // [fix-13.4] 403은 인증 실패가 아니다. Drive는 accessNotConfigured(API 미활성화),
            //            domainPolicy(Workspace 제3자 앱 제한), 쿼터 초과에도 403을 주며
            //            어느 것도 재로그인으로 풀리지 않는다. 토큰 삭제 대상은 401뿐이고,
            //            403은 쿼터성일 수 있으므로 백오프 재시도에 맡긴다.
            if (status === 401) {
                clearToken();
                throw e; // 재시도 없이 즉시 throw
            }
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
        }
    }
}

// ── app_meta 접근 ────────────────────────────────────────────────────────────
function getMeta(key) {
    return new Promise((resolve) => {
        db.get('SELECT value FROM app_meta WHERE key = ?', [key],
            (err, row) => resolve(err || !row ? null : row.value));
    });
}

// [fix-13.C2] 콜백 없는 db.run + 직후 db.get은 순서가 보장되지 않는다(기본 병렬 모드).
//   쓰기 완료를 기다린 뒤 읽도록 Promise로 바꾼다. 실패해도 진행은 막지 않는다.
function setMeta(key, value) {
    return new Promise((resolve) => {
        db.run('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)', [key, String(value ?? '')],
            (err) => {
                if (err) log.error('DB', `app_meta 저장 실패 [${key}]: ${err.message}`);
                resolve();
            });
    });
}

// ── 메모리 캐시 로드 ─────────────────────────────────────────────────────────
async function loadIndexToMemory() {
    // [fix-13.B4] 색인 때 저장해 둔 루트 폴더 이름을 먼저 읽는다 (없으면 옛 방식 폴백)
    rootFolderName = (await getMeta('rootFolderName')) || '';
    return new Promise((resolve, reject) => {
        log.info('Cache', '인덱스 로딩 중...');
        db.all('SELECT fileId, name, path, url FROM file_index', [], (err, rows) => {
            if (err) return reject(err);
            const newMap = new Map();
            rows.forEach(row => newMap.set(row.fileId, row));
            fileIndexCache = newMap;
            // 검색 키는 응답 본문에 섞이지 않도록 별도 구조에 둔다
            searchIndex = buildSearchIndex(rows, rootFolderName);
            log.info('Cache', `[${fileIndexCache.size}]개 파일 로드 완료`);
            resolve();
        });
    });
}

// ── Drive 전체 텍스트 검색 ───────────────────────────────────────────────────
// [fix-13.B9] 반환값에 complete를 함께 싣는다. 실패했거나 미인증이라 Drive 결과가
//   비어 있는 응답을 캐싱하면 일시적 장애가 6시간 고착된다.
async function driveFullTextSearch(keyword) {
    if (!isAuthenticated()) return { ids: [], complete: false };
    const drive = getDriveClient();
    // [fix-B5] 큰따옴표도 이스케이프 추가 (이전: `"` 미처리로 Drive API 쿼리 malformed)
    const escaped = keyword.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    const q = `fullText contains '"${escaped}"' and trashed=false`;
    const ids = [];
    let pageToken = null;

    do {
        const params = {
            q,
            fields: 'nextPageToken, files(id)',
            pageSize: 1000,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        };
        if (pageToken) params.pageToken = pageToken;

        // [fix-13.C3] 페이지마다 소비한다. 함수 1회당 1로 세면 페이지네이션이
        //   많은 키워드에서 실제 Drive 호출 수를 크게 과소평가한다.
        consumeDriveBudget();
        const response = await withRetry(() => drive.files.list(params));
        (response.data.files || []).forEach(f => ids.push(f.id));
        pageToken = response.data.nextPageToken || null;
    } while (pageToken);

    log.info('Drive', `드라이브 검색: [${keyword}] → [${ids.length}]건`);
    return { ids, complete: true };
}

// ── 로컬 인덱스에서 파일명/하위 폴더 경로 검색 ────────────────────────────────
function getNameMatches(keyword) {
    return matchKeyword(searchIndex, keyword);
}

// ── 키워드 캐시 조회 ─────────────────────────────────────────────────────────
function getCachedFileIds(keyword) {
    return new Promise((resolve) => {
        db.get(
            'SELECT fileIds, cachedAt FROM keyword_cache WHERE keyword = ?',
            [keyword],
            (err, row) => {
                if (err || !row) return resolve(null);
                if (Date.now() - row.cachedAt > CACHE_TTL_MS) return resolve(null);
                try { resolve(JSON.parse(row.fileIds)); }
                catch { resolve(null); }
            }
        );
    });
}

// ── 키워드 캐시 저장 ─────────────────────────────────────────────────────────
function setCachedFileIds(keyword, fileIds) {
    db.run(
        'INSERT OR REPLACE INTO keyword_cache (keyword, fileIds, cachedAt) VALUES (?, ?, ?)',
        [keyword, JSON.stringify(fileIds), Date.now()],
        (err) => {
            if (err) log.error('Cache', `캐시 저장 실패 [${keyword}]: ${err.message}`);
        }
    );
}

// ── 키워드 → fileId 배열 (캐시 → Drive 검색 → 로컬 인덱스 합산) ──────────────
async function getFileIdsForKeyword(keyword) {
    // [fix-B6] toLowerCase 추가 — 직접 호출 시 대소문자 불일치로 캐시 미스 방지
    // [fix-13.11] 색인 측과 같은 NFC 정규화를 적용
    keyword = normalizeKeyword(keyword);
    // [fix-13.10] 따옴표만으로 이뤄진 질의(`""`)는 여기서 빈 문자열이 되고,
    //             그대로 두면 includes('')가 전 파일에 걸려 F16 가드를 우회한다.
    if (!keyword) return [];

    const cached = await getCachedFileIds(keyword);
    if (cached !== null) {
        log.info('Drive', `캐시 히트: [${keyword}] → [${cached.length}]건`);
        return cached;
    }

    // [fix-13.C3] 여기서부터 Drive가 필요하다. 예산이 없으면 이 요청은 429다.
    if (driveBudgetExhausted()) throw new DriveBudgetError();

    // [fix-13.9] Drive 응답을 기다리는 사이 인덱스가 교체되면 이 결과는 옛 인덱스 기준이다
    const generationAtStart = indexGeneration;

    const [drive, nameIds] = await Promise.all([
        driveFullTextSearch(keyword).catch(e => {
            noteDriveError(`검색 실패 [${keyword}]: ${e.message}`);
            log.error('Drive', `검색 실패 [${keyword}]: ${e.message}`);
            return { ids: [], complete: false };
        }),
        Promise.resolve(getNameMatches(keyword)),
    ]);

    const combined = [...new Set([...drive.ids, ...nameIds])];
    // [fix-13.B9] 이번 요청에는 가진 만큼 돌려주되, 불완전한 결과는 캐싱하지 않는다.
    //   캐싱하면 네트워크 순단·쿼터 403 한 번이 그 키워드를 6시간 동안 이름 검색만
    //   되는 상태로 고정시키고, 교사는 "자료가 없다"고 판단하게 된다.
    if (!drive.complete) {
        log.warn('Cache', `Drive 결과 불완전 — 캐시 저장 생략 [${keyword}]`);
    } else if (indexGeneration !== generationAtStart) {
        log.warn('Cache', `인덱스 교체로 캐시 저장 생략 [${keyword}]`);
    } else {
        setCachedFileIds(keyword, combined);
    }
    return combined;
}

// ── 인덱스 재빌드 ────────────────────────────────────────────────────────────
// [fix-13.B2] 실행 결과를 남겨 /api/health로 노출한다. 3·4번 수정 이후 인증 실패가
//             화면에 아무 흔적도 남기지 않게 된 것을 보완한다.
async function rebuildMetadataIndex() {
    let result = 'error';
    try {
        result = await _runRebuild();
        return result;
    } catch (e) {
        rebuildNote = e.message;
        throw e;
    } finally {
        lastRebuild = { at: ts(), result, message: rebuildNote };
        rebuildNote = null;
    }
}

async function _runRebuild() {
    if (!isAuthenticated()) {
        log.warn('Index', '인증되지 않음 — 인덱싱 건너뜀');
        rebuildNote = '인증되지 않음 (token.json 없음 또는 만료)';
        return 'unauthenticated';
    }
    if (isIndexing) {
        log.warn('Index', '이미 실행 중 — 인덱싱 건너뜀');
        return 'skipped';
    }
    if (!FOLDER_ID) {
        log.error('Index', 'FOLDER_ID 환경변수 미설정');
        rebuildNote = 'FOLDER_ID 환경변수 미설정';
        return 'error';
    }

    isIndexing = true;
    log.info('Index', '인덱싱 시작');

    try {
        const drive = getDriveClient();
        const folderQueue = [{ id: FOLDER_ID, path: '' }];
        const fileRows = [];
        // [fix-13.3] 탐색 중 한 건이라도 실패하면 인덱스는 불완전하다.
        //            불완전한 인덱스로 기존 인덱스를 덮어쓰지 않는다.
        let traversalFailed = false;
        let rootName = '';

        while (folderQueue.length > 0) {
            const current = folderQueue.shift();

            let folderName = '';
            try {
                const meta = await withRetry(() => drive.files.get({
                    fileId: current.id,
                    fields: 'name',
                    supportsAllDrives: true,
                }));
                folderName = meta.data.name || '';
                // [fix-13.B4] 큐의 첫 항목이 루트다 (path === '')
                if (current.path === '') rootName = folderName;
            } catch (e) {
                // 이름을 못 얻으면 하위 파일의 경로가 통째로 어긋나 경로 검색이 깨진다
                traversalFailed = true;
                noteDriveError(`폴더 이름 조회 실패 [${current.id}]: ${e.message}`);
                log.error('Index', `폴더 이름 조회 실패 [${current.id}]: ${e.message}`);
            }

            const currentPath = current.path
                ? current.path + '/' + folderName
                : folderName;

            let pageToken = null;
            do {
                const params = {
                    q: `'${current.id}' in parents and trashed=false`,
                    fields: 'nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime)',
                    pageSize: 1000,
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                };
                if (pageToken) params.pageToken = pageToken;

                let response;
                try {
                    response = await withRetry(() => drive.files.list(params));
                } catch (e) {
                    traversalFailed = true;
                    noteDriveError(`파일 목록 조회 실패 [${current.id}]: ${e.message}`);
                    log.error('Index', `파일 목록 조회 실패 [${current.id}]: ${e.message}`);
                    break;
                }

                for (const file of response.data.files || []) {
                    if (file.mimeType === 'application/vnd.google-apps.folder') {
                        folderQueue.push({ id: file.id, path: currentPath });
                    } else {
                        fileRows.push([
                            file.id, file.name, currentPath,
                            file.webViewLink || '', file.modifiedTime || '',
                        ]);
                    }
                }

                pageToken = response.data.nextPageToken || null;
            } while (pageToken);
        }

        // [fix-13.3] 커밋 전 게이트 — 실패한 탐색 결과로 기존 인덱스를 교체하지 않는다.
        //            네트워크 단절·쿼터·refresh token 폐기 어느 경우든 여기서 멈춘다.
        if (traversalFailed) {
            log.error('Index', '탐색 중 오류 발생 — 인덱스를 교체하지 않고 기존 인덱스를 유지합니다');
            rebuildNote = '탐색 중 오류로 중단 — 기존 인덱스 유지 (Drive 접근 상태 확인 필요)';
            return 'error';
        }
        if (fileRows.length === 0) {
            log.error('Index', '탐색 결과가 0건 — 인덱스를 교체하지 않고 기존 인덱스를 유지합니다');
            rebuildNote = '탐색 결과 0건 — 기존 인덱스 유지 (FOLDER_ID와 폴더 내용 확인 필요)';
            return 'error';
        }

        // [fix-13.B5] 세대를 교체 '완료' 시점이 아니라 '확정' 시점에 올린다. 완료 시점에
        //             올리면 DELETE~loadIndexToMemory 구간에 Drive 응답이 도착한 검색이
        //             같은 세대로 판정돼 옛 인덱스 기준 결과를 6시간 캐싱했다.
        //             롤백되면 불필요하게 캐시 저장을 한 번 건너뛸 뿐 손해는 없다.
        indexGeneration++;

        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) return reject(err);
                db.run('DELETE FROM file_index', (err) => {
                    if (err) {
                        log.error('Index', `file_index 삭제 실패: ${err.message}`);
                        return db.run('ROLLBACK', () => reject(err));
                    }
                    db.run('DELETE FROM keyword_cache', (err) => {
                        if (err) {
                            log.error('Index', `keyword_cache 삭제 실패: ${err.message}`);
                            return db.run('ROLLBACK', () => reject(err));
                        }
                        const stmt = db.prepare(
                            'INSERT OR REPLACE INTO file_index (fileId, name, path, url, modifiedAt) VALUES (?, ?, ?, ?, ?)'
                        );
                        for (const row of fileRows) stmt.run(row);
                        stmt.finalize((err) => {
                            if (err) {
                                return db.run('ROLLBACK', () => reject(err));
                            }
                            db.run('COMMIT', (err) => {
                                if (err) return db.run('ROLLBACK', () => reject(err));
                                resolve();
                            });
                        });
                    });
                });
            });
        });

        await setMeta('rootFolderName', rootName);   // [fix-13.B4][fix-13.C2] 읽기 전에 완료 보장
        log.info('Index', `인덱싱 완료 → [${fileRows.length}]개 파일`);
        await loadIndexToMemory();
        return 'done';
    } catch (e) {
        log.error('Index', `인덱싱 중 오류 발생: ${e.message}`);
        rebuildNote = e.message;
        return 'error';
    } finally {
        isIndexing = false;
    }
}

// ── SHA-256 유틸 ─────────────────────────────────────────────────────────────
function sha256(str) {
    return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// ── 비밀번호 검증 헬퍼 ───────────────────────────────────────────────────────
// [fix-E12] ADMIN_PASSWORD 미설정 방어 + timingSafeEqual로 타이밍 공격 완화
function verifyPassword(passwordHash) {
    if (!ADMIN_PASSWORD) return false;
    const serverHash = sha256(ADMIN_PASSWORD);
    try {
        const clientBuf = Buffer.from(String(passwordHash || ''), 'hex');
        const serverBuf = Buffer.from(serverHash, 'hex');
        // 길이가 다르면(hex가 아닌 입력 등) 즉시 false
        if (clientBuf.length !== serverBuf.length) return false;
        return crypto.timingSafeEqual(clientBuf, serverBuf);
    } catch {
        return false;
    }
}

// ── OAuth 라우트 ─────────────────────────────────────────────────────────────
app.post('/api/auth/initiate', (req, res) => {
    const { passwordHash } = req.body || {};
    // [fix-E12] verifyPassword 헬퍼로 교체
    if (!verifyPassword(passwordHash)) {
        log.warn('Admin', 'OAuth 시작 요청 — 비밀번호 불일치');
        return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
    }
    try {
        const oAuth2Client = getOAuthClient();
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/drive.readonly'],
            prompt: 'consent',
        });
        log.info('Admin', 'OAuth 시작 허가, URL 발급');
        res.status(200).json({ url: authUrl });
    } catch (e) {
        log.error('Auth', `credentials.json 로드 실패: ${e.message}`);
        res.status(500).json({ error: '서버 오류: credentials.json을 확인하세요.' });
    }
});

app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('인증 코드가 없습니다.');

    try {
        const oAuth2Client = getOAuthClient();
        const { tokens } = await oAuth2Client.getToken(code);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        log.info('Auth', 'OAuth 인증 완료, token.json 저장');

        rebuildMetadataIndex().catch(e => log.error('Index', `인덱스 생성 실패: ${e.message}`));
        res.redirect('/');
    } catch (e) {
        log.error('Auth', `OAuth 콜백 오류: ${e.message}`);
        res.status(500).send('OAuth 인증에 실패했습니다. 다시 시도하세요.');
    }
});

// ── Drive 호출 예산 ──────────────────────────────────────────────────────────
let driveWindowStart = Date.now();
let driveWindowCalls = 0;

function rollDriveWindow() {
    const now = Date.now();
    if (now - driveWindowStart > DRIVE_BUDGET_WINDOW_MS) {
        driveWindowStart = now;
        driveWindowCalls = 0;
    }
}

/** Drive 호출 1건 소비 — driveFullTextSearch에서만 부른다 */
function consumeDriveBudget() {
    rollDriveWindow();
    driveWindowCalls++;
}

/** 이번 창의 예산이 소진됐는가 */
function driveBudgetExhausted() {
    rollDriveWindow();
    return driveWindowCalls >= DRIVE_CALL_BUDGET;
}

// [fix-13.C3] 예산 초과는 '캐시 미스라 Drive가 필요한' 시점에만 판정한다.
//   요청 진입부에서 막으면 캐시로 끝날 검색까지 429가 되는데, 그건 쿼터를 전혀
//   보호하지 못하면서 정상 사용만 막는다.
class DriveBudgetError extends Error {
    constructor() { super('DRIVE_BUDGET_EXCEEDED'); this.code = 'DRIVE_BUDGET'; }
}

// ── 검색 API ─────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query) return res.json([]);

    try {
        // [fix-13.B1] 흐름 자체는 search-pipeline.js에 있다. 여기는 I/O만 주입한다.
        //             대조 테스트가 같은 함수를 호출하므로 사본이 갈라질 여지가 없다.
        const out = await runSearch(query, {
            resolveKeyword: getFileIdsForKeyword,
            allIds: () => new Set(fileIndexCache.keys()),
            lookup: (id) => fileIndexCache.get(id),
            // [fix-13.12] 질의 문자열 전체가 아니라 개별 키워드를 기록한다.
            logKeyword,
        });

        if (out.error) return res.status(400).json({ error: out.error });

        log.info('Search', `[${query}] → [${out.results.length}]건`);
        res.json(out.results);
    } catch (e) {
        // [fix-13.C3] Drive 예산 소진은 서버 오류가 아니라 일시적 거부다
        if (e.code === 'DRIVE_BUDGET') {
            log.warn('Search', `Drive 호출 예산 소진 — 요청 거부 [${query}]`);
            return res.status(429).json({ error: '검색 요청이 많습니다. 잠시 후 다시 시도해 주세요.' });
        }
        log.error('Search', `쿼리 처리 실패: ${e.message}`);
        res.status(500).json({ error: '검색 중 오류가 발생했습니다.' });
    }
});

// ── 어드민: 인덱스 재빌드 ────────────────────────────────────────────────────
app.post('/api/rebuild', (req, res) => {
    const { passwordHash } = req.body || {};
    // [fix-E12] verifyPassword 헬퍼로 교체
    if (!verifyPassword(passwordHash)) {
        log.warn('Admin', '인덱스 재빌드 요청 — 비밀번호 불일치');
        return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
    }
    if (isIndexing) {
        log.warn('Admin', '인덱스 재빌드 요청 — 이미 진행 중');
        return res.status(409).json({ message: '인덱싱이 이미 진행 중입니다.' });
    }

    log.info('Admin', '인덱스 재빌드 요청 — 수락');
    res.status(202).json({ message: '인덱싱을 시작합니다.' });
    rebuildMetadataIndex().catch(e => log.error('Index', `인덱스 생성 실패: ${e.message}`));
});

// ── 헬스체크 ─────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    // [fix-13.B2] authenticated는 token.json의 refresh_token 존재만 본다. 토큰이 폐기됐거나
    //             영구 403이어도 true다. 마지막 재빌드 결과와 마지막 Drive 오류를 함께 노출해
    //             "인덱스는 멀쩡한데 갱신이 멈춰 있는" 상태를 관리자가 알 수 있게 한다.
    const healthy = lastRebuild.result === null || lastRebuild.result === 'done';
    res.json({
        status: healthy ? 'ok' : 'degraded',
        uptime: Math.floor(process.uptime()),
        authenticated: isAuthenticated(),
        isIndexing,
        indexedCount: fileIndexCache.size,
        lastRebuild,
        lastDriveError,
    });
});

// ── 키워드 로그 ──────────────────────────────────────────────────────────────
function logKeyword(keyword) {
    const today = todayStr();   // [fix-13.1] 크론과 같은 시간대의 날짜 경계를 쓴다
    db.run(`
        INSERT INTO keyword_log (keyword, count, lastSearchDay)
        VALUES (?, 1, ?)
        ON CONFLICT(keyword) DO UPDATE SET
            count = count + 1,
            lastSearchDay = ?
    `, [keyword, today, today],
    (err) => {
        if (err) log.error('Log', `키워드 로그 실패 [${keyword}]: ${err.message}`);
    });
}

// ── 만료 키워드 정리 ─────────────────────────────────────────────────────────
function purgeStaleKeywords() {
    // [fix-13.1] 날짜 경계도 TIMEZONE 기준. logKeyword가 쓰는 형식과 같아야 비교가 맞다.
    const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
    db.run('DELETE FROM keyword_log WHERE lastSearchDay < ?', [cutoffStr],
        function (err) {
            if (err) return log.error('Purge', `키워드 정리 실패: ${err.message}`);
            log.info('Purge', `만료 키워드 [${this.changes}]개 삭제 완료`);
        }
    );
}

// ── Warm Cache ───────────────────────────────────────────────────────────────
function warmCache() {
    if (isWarmingCache) {
        log.warn('WarmCache', '이미 실행 중, 건너뜀');
        return;
    }
    isWarmingCache = true;
    db.all(
        'SELECT keyword FROM keyword_log ORDER BY count DESC, lastSearchDay DESC LIMIT ?',
        [PRECACHE_TOP_N],
        async (err, rows) => {
            try {
                if (err) { log.error('WarmCache', `키워드 조회 실패: ${err.message}`); return; }
                const wStart = Date.now();
                let warmed = 0;
                for (const { keyword } of rows) {
                    if (Date.now() - wStart > WARM_CACHE_LIMIT_MS) {
                        log.warn('WarmCache', '시간 초과로 캐시 워밍 조기 종료');
                        break;
                    }
                    const tokens = tokenize(keyword);
                    const tree = new BooleanParser(tokens).parse();
                    const kws = [...extractKeywords(tree)];
                    for (const kw of kws) {
                        // 캐시 조회 키를 getFileIdsForKeyword와 동일하게 정규화 (미스 방지)
                        const norm = normalizeKeyword(kw);
                        if (!norm) continue;
                        const cached = await getCachedFileIds(norm);
                        if (cached !== null) continue;
                        await getFileIdsForKeyword(norm).catch(e =>
                            log.error('WarmCache', `워밍 실패 [${norm}]: ${e.message}`)
                        );
                    }
                    warmed++;
                }
                log.info('WarmCache', `[${warmed}]개 키워드 Drive 캐시 워밍 완료`);
            } finally {
                isWarmingCache = false;
            }
        }
    );
}

// ── Cron 스케줄 ──────────────────────────────────────────────────────────────
// [fix-13.1] timezone을 명시하지 않으면 node-cron이 프로세스 로컬(컨테이너 기본 UTC)을 써서
//            KST 11:00에 전체 재인덱싱이 돈다. 컨테이너 TZ와 무관하게 동작하도록 옵션으로 고정.
const cronOptions = { timezone: TIMEZONE };
cron.schedule('0 2 * * *',          () => rebuildMetadataIndex().catch(e => log.error('Cron', e.message)), cronOptions);
cron.schedule('30 2,7,12,17 * * *', () => warmCache(), cronOptions);
cron.schedule('0 3 * * *',          () => purgeStaleKeywords(), cronOptions);

// ── 서버 시작 ────────────────────────────────────────────────────────────────
initDB()
    .then(() => loadIndexToMemory())
    .then(() => {
        app.listen(PORT, () => {
            log.info('Server', `포트 [${PORT}]에서 가동 중`);
            if (!isAuthenticated()) {
                log.warn('Auth', '미인증 상태 — 프론트엔드 관리자 모달에서 Google 로그인 필요');
            }
        });
    })
    .then(() => rebuildMetadataIndex())
    .catch(err => {
        log.error('Server', `초기화 실패: ${err.message}`);
        process.exit(1);
    });
