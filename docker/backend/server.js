require('dotenv').config();

const fs = require('fs');
const express = require('express');
const { google } = require('googleapis');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const crypto = require('crypto');
const { BooleanParser, tokenize, evaluate } = require('./parser');

const app = express();
app.use(express.json());

const PORT              = process.env.PORT || 3000;
const FOLDER_ID         = process.env.FOLDER_ID;
const ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost/oauth/callback';
const PRECACHE_TOP_N    = 100;
const CACHE_TTL_MS      = 6 * 60 * 60 * 1000;
const WARM_CACHE_LIMIT_MS = 4 * 60 * 1000;
const RETRY_COUNT       = 3;
const RETRY_DELAY_MS    = 500;

const CREDENTIALS_PATH = '/app/data/credentials.json';
const TOKEN_PATH       = '/app/data/token.json';

const db = new sqlite3.Database('/app/data/database.sqlite');
let fileIndexCache = new Map();
let isIndexing = false;

// ── 로거 ─────────────────────────────────────────────────────────────────────
const ts = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
const log = {
    info:  (tag, msg) => console.log(`[${ts()}]\t[INFO ]\t[${tag.padEnd(9)}]\t${msg}`),
    warn:  (tag, msg) => console.warn(`[${ts()}]\t[WARN ]\t[${tag.padEnd(9)}]\t${msg}`),
    error: (tag, msg) => console.error(`[${ts()}]\t[ERROR]\t[${tag.padEnd(9)}]\t${msg}`),
};

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
            if (status === 401 || status === 403) {
                clearToken();
                throw e; // 재시도 없이 즉시 throw
            }
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
        }
    }
}

// ── 메모리 캐시 로드 ─────────────────────────────────────────────────────────
function loadIndexToMemory() {
    return new Promise((resolve, reject) => {
        log.info('Cache', '인덱스 로딩 중...');
        db.all('SELECT fileId, name, path, url FROM file_index', [], (err, rows) => {
            if (err) return reject(err);
            const newMap = new Map();
            rows.forEach(row => newMap.set(row.fileId, row));
            fileIndexCache = newMap;
            log.info('Cache', `[${fileIndexCache.size}]개 파일 로드 완료`);
            resolve();
        });
    });
}

// ── Drive 전체 텍스트 검색 ───────────────────────────────────────────────────
async function driveFullTextSearch(keyword) {
    if (!isAuthenticated()) return [];
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

        const response = await withRetry(() => drive.files.list(params));
        (response.data.files || []).forEach(f => ids.push(f.id));
        pageToken = response.data.nextPageToken || null;
    } while (pageToken);

    log.info('Drive', `드라이브 검색: [${keyword}] → [${ids.length}]건`);
    return ids;
}

// ── 로컬 인덱스에서 파일명/경로 검색 ──────────────────────────────────────────
function getNameMatches(keyword) {
    const results = [];
    for (const [id, file] of fileIndexCache) {
        if (file.name.toLowerCase().includes(keyword) ||
            file.path.toLowerCase().includes(keyword)) {
            results.push(id);
        }
    }
    return results;
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
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run(
            'INSERT OR REPLACE INTO keyword_cache (keyword, fileIds, cachedAt) VALUES (?, ?, ?)',
            [keyword, JSON.stringify(fileIds), Date.now()],
            (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    return log.error('Cache', `캐시 저장 실패 [${keyword}]: ${err.message}`);
                }
                db.run('COMMIT');
            }
        );
    });
}

// ── 키워드 → fileId 배열 (캐시 → Drive 검색 → 로컬 인덱스 합산) ──────────────
async function getFileIdsForKeyword(keyword) {
    // [fix-B6] toLowerCase 추가 — 직접 호출 시 대소문자 불일치로 캐시 미스 방지
    keyword = keyword.replace(/['"]/g, '').toLowerCase();
    const cached = await getCachedFileIds(keyword);
    if (cached !== null) {
        log.info('Drive', `캐시 히트: [${keyword}] → [${cached.length}]건`);
        return cached;
    }

    const [driveIds, nameIds] = await Promise.all([
        driveFullTextSearch(keyword).catch(e => {
            log.error('Drive', `검색 실패 [${keyword}]: ${e.message}`);
            return [];
        }),
        Promise.resolve(getNameMatches(keyword)),
    ]);

    const combined = [...new Set([...driveIds, ...nameIds])];
    setCachedFileIds(keyword, combined);
    return combined;
}

// ── AST에서 키워드 추출 ──────────────────────────────────────────────────────
function extractKeywords(node) {
    if (!node || node.type === 'EMPTY') return new Set();
    if (node.type === 'KEYWORD') return new Set([node.value]);
    if (node.type === 'NOT') return extractKeywords(node.operand);
    return new Set([...extractKeywords(node.left), ...extractKeywords(node.right)]);
}

// ── 인덱스 재빌드 ────────────────────────────────────────────────────────────
async function rebuildMetadataIndex() {
    if (!isAuthenticated()) {
        log.warn('Index', '인증되지 않음 — 인덱싱 건너뜀');
        return 'unauthenticated';
    }
    if (isIndexing) {
        log.warn('Index', '이미 실행 중 — 인덱싱 건너뜀');
        return 'skipped';
    }
    if (!FOLDER_ID) {
        log.error('Index', 'FOLDER_ID 환경변수 미설정');
        return 'error';
    }

    isIndexing = true;
    log.info('Index', '인덱싱 시작');

    try {
        const drive = getDriveClient();
        const folderQueue = [{ id: FOLDER_ID, path: '' }];
        const fileRows = [];

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
            } catch (e) {
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

        await new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                // [fix-C9] DELETE 실패 시 로그 남기도록 에러 콜백 추가
                db.run('DELETE FROM file_index', (err) => {
                    if (err) log.error('Index', `file_index 삭제 실패: ${err.message}`);
                });
                db.run('DELETE FROM keyword_cache', (err) => {
                    if (err) log.error('Index', `keyword_cache 삭제 실패: ${err.message}`);
                });
                const stmt = db.prepare(
                    'INSERT OR REPLACE INTO file_index (fileId, name, path, url, modifiedAt) VALUES (?, ?, ?, ?, ?)'
                );
                for (const row of fileRows) stmt.run(row);
                stmt.finalize((err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        return reject(err);
                    }
                    db.run('COMMIT', (err) => {
                        if (err) { db.run('ROLLBACK'); return reject(err); }
                        resolve();
                    });
                });
            });
        });

        log.info('Index', `인덱싱 완료 → [${fileRows.length}]개 파일`);
        await loadIndexToMemory();
        return 'done';
    } catch (e) {
        log.error('Index', `인덱싱 중 오류 발생: ${e.message}`);
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

// ── 검색 API ─────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query) return res.json([]);

    try {
        const tokens = tokenize(query);
        const tree = new BooleanParser(tokens).parse();
        const keywords = [...extractKeywords(tree)];
        // [fix-F16] 키워드가 없는 쿼리(순수 연산자 등) 차단 — NOT(EMPTY)로 전체 파일 목록 노출 방지
        if (keywords.length === 0) return res.json([]);

        const fileIdArrays = await Promise.all(keywords.map(kw => getFileIdsForKeyword(kw)));

        const keywordMap = new Map();
        keywords.forEach((kw, i) => keywordMap.set(kw, new Set(fileIdArrays[i])));

        const allIds = new Set(fileIndexCache.keys());
        const resultSet = evaluate(tree, keywordMap, allIds);

        const results = Array.from(resultSet)
            .map(id => fileIndexCache.get(id))
            .filter(Boolean)
            .sort((a, b) => a.path.localeCompare(b.path, 'ko') || a.name.localeCompare(b.name, 'ko'));

        log.info('Search', `[${query}] → [${results.length}]건`);
        logKeyword(query);
        res.json(results);
    } catch (e) {
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
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        authenticated: isAuthenticated(),
        isIndexing,
        indexedCount: fileIndexCache.size,
    });
});

// ── 키워드 로그 ──────────────────────────────────────────────────────────────
function logKeyword(keyword) {
    const today = new Date().toISOString().split('T')[0];
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run(`
            INSERT INTO keyword_log (keyword, count, lastSearchDay)
            VALUES (?, 1, ?)
            ON CONFLICT(keyword) DO UPDATE SET
                count = count + 1,
                lastSearchDay = ?
        `, [keyword, today, today],
        (err) => {
            if (err) { db.run('ROLLBACK'); return log.error('Log', `키워드 로그 실패 [${keyword}]: ${err.message}`); }
            db.run('COMMIT');
        });
    });
}

// ── 만료 키워드 정리 ─────────────────────────────────────────────────────────
function purgeStaleKeywords() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run('DELETE FROM keyword_log WHERE lastSearchDay < ?', [cutoffStr],
            function (err) {
                if (err) { db.run('ROLLBACK'); return log.error('Purge', `키워드 정리 실패: ${err.message}`); }
                log.info('Purge', `만료 키워드 [${this.changes}]개 삭제 완료`);
                db.run('COMMIT');
            }
        );
    });
}

// ── Warm Cache ───────────────────────────────────────────────────────────────
function warmCache() {
    db.all(
        'SELECT keyword FROM keyword_log ORDER BY count DESC, lastSearchDay DESC LIMIT ?',
        [PRECACHE_TOP_N],
        async (err, rows) => {
            if (err) return log.error('WarmCache', `키워드 조회 실패: ${err.message}`);
            // [fix-B7] 시간 초과 보호 추가 (GAS와 동일하게 4분 제한)
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
                    const cached = await getCachedFileIds(kw);
                    if (cached !== null) continue;
                    await getFileIdsForKeyword(kw).catch(e =>
                        log.error('WarmCache', `워밍 실패 [${kw}]: ${e.message}`)
                    );
                }
                warmed++;
            }
            log.info('WarmCache', `[${warmed}]개 키워드 Drive 캐시 워밍 완료`);
        }
    );
}

// ── Cron 스케줄 ──────────────────────────────────────────────────────────────
cron.schedule('0 2 * * *',          () => rebuildMetadataIndex().catch(e => log.error('Cron', e.message)));
cron.schedule('30 2,7,12,17 * * *', () => warmCache());
cron.schedule('0 3 * * *',          () => purgeStaleKeywords());

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
