require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const cors = require('cors');
const crypto = require('crypto');
const { BooleanParser, tokenize, evaluate } = require('./parser');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FOLDER_ID = process.env.FOLDER_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SERVICE_ACCOUNT_KEY_PATH = process.env.SERVICE_ACCOUNT_KEY_PATH || '/app/data/service-account.json';
const PRECACHE_TOP_N = 100;

const db = new sqlite3.Database('/app/data/database.sqlite');
let fileIndexCache = new Map();
let isIndexing = false;

// ── 로거 ─────────────────────────────────────────────────────────────────────
const log = {
    info:  (tag, msg) => console.log(`[INFO]  [${tag}] ${msg}`),
    warn:  (tag, msg) => console.warn(`[WARN]  [${tag}] ${msg}`),
    error: (tag, msg) => console.error(`[ERROR] [${tag}] ${msg}`),
};

// ── DB 초기화 ────────────────────────────────────────────────────────────────
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
            `);
            db.run(`
                CREATE TABLE IF NOT EXISTS keyword_log (
                    keyword       TEXT PRIMARY KEY,
                    count         INTEGER DEFAULT 1,
                    lastSearchDay TEXT
                )
            `, (err) => {
                if (err) return reject(err);
                log.info('DB', '스키마 초기화 완료');
                resolve();
            });
        });
    });
}

// ── Google Drive 인증 ────────────────────────────────────────────────────────
function getDriveClient() {
    const auth = new google.auth.GoogleAuth({
        keyFile: SERVICE_ACCOUNT_KEY_PATH,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    return google.drive({ version: 'v3', auth });
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
            log.info('Cache', `${fileIndexCache.size}개 파일 로드 완료`);
            resolve();
        });
    });
}

// ── 인덱스 재빌드 (Google Drive API BFS 탐색) ────────────────────────────────
async function rebuildMetadataIndex() {
    if (isIndexing) {
        log.warn('Index', '이미 실행 중, 건너뜀');
        return 'skipped';
    }
    if (!FOLDER_ID) {
        log.error('Index', 'FOLDER_ID 환경변수가 설정되지 않았습니다');
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
                const meta = await drive.files.get({
                    fileId: current.id,
                    fields: 'name',
                    supportsAllDrives: true,
                });
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
                    response = await drive.files.list(params);
                } catch (e) {
                    log.error('Index', `파일 목록 조회 실패 [${current.id}]: ${e.message}`);
                    break;
                }

                for (const file of response.data.files || []) {
                    if (file.mimeType === 'application/vnd.google-apps.folder') {
                        folderQueue.push({ id: file.id, path: currentPath });
                    } else {
                        fileRows.push([
                            file.id,
                            file.name,
                            currentPath,
                            file.webViewLink || '',
                            file.modifiedTime || '',
                        ]);
                    }
                }

                pageToken = response.data.nextPageToken || null;
            } while (pageToken);
        }

        await new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('DELETE FROM file_index');
                const stmt = db.prepare(
                    'INSERT OR REPLACE INTO file_index (fileId, name, path, url, modifiedAt) VALUES (?, ?, ?, ?, ?)'
                );
                for (const row of fileRows) stmt.run(row);
                stmt.finalize((err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });

        log.info('Index', `인덱싱 완료 (${fileRows.length}개 파일)`);
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

// ── 검색 API ─────────────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query) return res.json([]);

    try {
        const tokens = tokenize(query);
        const tree = new BooleanParser(tokens).parse();
        const resultSet = evaluate(tree, fileIndexCache);
        const results = Array.from(resultSet).map(id => fileIndexCache.get(id)).filter(Boolean);

        log.info('Search', `"${query}" → ${results.length}건`);
        logKeyword(query);
        res.json(results);
    } catch (e) {
        log.error('Search', `쿼리 처리 실패: ${e.message}`);
        res.status(500).json({ error: '검색 중 오류가 발생했습니다.' });
    }
});

// ── 어드민: 인덱스 재빌드 ────────────────────────────────────────────────────
app.post('/api/admin/rebuild', (req, res) => {
    const { passwordHash } = req.body || {};
    if (!passwordHash || passwordHash !== sha256(ADMIN_PASSWORD || '')) {
        log.warn('Admin', '인덱스 재빌드 요청 — 비밀번호 불일치');
        return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
    }

    if (isIndexing) {
        log.warn('Admin', '인덱스 재빌드 요청 — 이미 진행 중');
        return res.status(409).json({ message: '인덱싱이 이미 진행 중입니다.' });
    }

    log.info('Admin', '인덱스 재빌드 요청 수락');
    res.status(202).json({ message: '인덱싱을 시작합니다.' });
    rebuildMetadataIndex().catch(e => log.error('Index', `비동기 인덱싱 오류: ${e.message}`));
});

// ── 어드민: 인덱싱 상태 조회 ─────────────────────────────────────────────────
app.get('/api/admin/status', (req, res) => {
    res.json({ isIndexing, indexedCount: fileIndexCache.size });
});

// ── 키워드 로그 ──────────────────────────────────────────────────────────────
function logKeyword(keyword) {
    const today = new Date().toISOString().split('T')[0];
    db.run(`
        INSERT INTO keyword_log (keyword, count, lastSearchDay)
        VALUES (?, 1, ?)
        ON CONFLICT(keyword) DO UPDATE SET
            count = count + 1,
            lastSearchDay = ?
    `, [keyword, today, today]);
}

// ── 만료 키워드 정리 (3일 미검색 삭제) ──────────────────────────────────────
function purgeStaleKeywords() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    db.run(
        'DELETE FROM keyword_log WHERE lastSearchDay < ?',
        [cutoffStr],
        function (err) {
            if (err) return log.error('Purge', `키워드 정리 실패: ${err.message}`);
            log.info('Purge', `만료 키워드 ${this.changes}개 삭제`);
        }
    );
}

// ── Warm Cache ───────────────────────────────────────────────────────────────
function warmCache() {
    db.all(
        'SELECT keyword FROM keyword_log ORDER BY count DESC, lastSearchDay DESC LIMIT ?',
        [PRECACHE_TOP_N],
        (err, rows) => {
            if (err) return log.error('WarmCache', `키워드 조회 실패: ${err.message}`);
            let warmed = 0;
            for (const { keyword } of rows) {
                const tokens = tokenize(keyword);
                const tree = new BooleanParser(tokens).parse();
                evaluate(tree, fileIndexCache);
                warmed++;
            }
            log.info('WarmCache', `${warmed}개 키워드 완료`);
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
            log.info('Server', `포트 ${PORT}에서 가동 중`);
        });
    })
    .then(() => rebuildMetadataIndex())
    .catch(err => {
        log.error('Server', `초기화 실패: ${err.message}`);
        process.exit(1);
    });
