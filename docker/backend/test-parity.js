// ── GAS ↔ Docker 구현 대조 테스트 ────────────────────────────────────────────
//
// 두 구현(src/Code.gs, docker/backend/*.js)은 같은 앱이라고 주장하지만 소스가 따로다.
//
// [fix-13.B1] 1판은 양쪽의 매칭 로직을 테스트 안에서 재구현해 비교했다. 그래서
//   `getNameMatchesFromSheet`(2번 버그를 낳은 바로 그 함수)와 `doSearch`의 응답 형태
//   (6번)가 대조 대상에서 빠졌고, 두 버그를 다시 주입해도 168/168이 통과했다.
//   이 판은 **양쪽의 실제 함수를 그대로 호출한다.**
//     - GAS   : Code.gs를 vm에 올리고 진짜 `doSearch(query)`를 부른다.
//     - Docker: 진짜 `runSearch(query, io)`(= /api/search가 쓰는 그 함수)를 부른다.
//
// 스텁 범위 (외부 I/O만):
//     CacheService        → 인메모리 구현 (청크 캐시 경로를 실제로 통과한다)
//     SpreadsheetApp      → 픽스처 기반 FileIndex 시트 (getCachedMetadataMap이 실제로 돈다)
//     driveFullTextSearch → [] 고정 (외부 호출이라 대조 불가)
//     logKeywords/logKeyword → 스파이 (호출 여부·인자를 대조)
//
// 여전히 대조 대상이 아닌 것: SQLite, OAuth, 크론, Drive 응답, 프론트엔드 DOM.
//
// 실행: node test-parity.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { tokenize, BooleanParser } = require('./parser');
const SK = require('./search-keys');
const { runSearch } = require('./search-pipeline');

// ── 공용 픽스처 ──────────────────────────────────────────────────────────────
// 실제 인덱스처럼 모든 경로가 루트 폴더 이름으로 시작한다.
// [fix-13.B4] Drive는 폴더명에 '/'를 허용한다. 슬래시가 든 루트로도 전 항목을 돌린다.
const makeCorpus = (ROOT) => [
    { fileId: 'f1', name: '서울대 수시 논술 2027',  path: `${ROOT}/서울대`,   url: 'u1' },
    { fileId: 'f2', name: '연세대 수시 면접 2027',  path: `${ROOT}/연세대`,   url: 'u2' },
    { fileId: 'f3', name: '고려대 정시 논술 2026',  path: `${ROOT}/고려대`,   url: 'u3' },
    { fileId: 'f4', name: '서울대 정시 교과 2026',  path: `${ROOT}/서울대`,   url: 'u4' },
    { fileId: 'f5', name: '카이스트 논술 면접 2027', path: `${ROOT}/이공계`,   url: 'u5' },
    { fileId: 'f6', name: 'android 개발 가이드',     path: `${ROOT}/기술문서`, url: 'u6' },
    { fileId: 'f7', name: 'notable 키워드 테스트',   path: `${ROOT}/기술문서`, url: 'u7' },
    { fileId: 'f8', name: 'oracle 데이터베이스',     path: `${ROOT}/기술문서`, url: 'u8' },
    { fileId: 'f9', name: '교과 중심 학생부 전형',   path: `${ROOT}/학생부`,   url: 'u9' },
    { fileId: 'fA', name: '논술 자료'.normalize('NFD'), path: `${ROOT}/서울대`.normalize('NFD'), url: 'uA' },
    { fileId: 'fB', name: 2027,  path: `${ROOT}/기타`, url: 'uB' },   // 시트가 숫자로 돌려준 경우
    { fileId: 'fC', name: '공백 포함 키워드 문서',   path: ROOT,       url: 'uC' },  // 루트 직속
];

// ── GAS 실행 환경 (외부 I/O만 스텁) ──────────────────────────────────────────
const CODE_GS = path.join(__dirname, '..', '..', 'src', 'Code.gs');

function makeCacheService() {
    const store = new Map();
    const cache = {
        get: (k) => (store.has(k) ? store.get(k) : null),
        put: (k, v) => { store.set(k, String(v)); },
        getAll: (keys) => {
            const out = {};
            keys.forEach(k => { if (store.has(k)) out[k] = store.get(k); });
            return out;
        },
        putAll: (obj) => { Object.entries(obj).forEach(([k, v]) => store.set(k, String(v))); },
        remove: (k) => { store.delete(k); },
        removeAll: (keys) => { keys.forEach(k => store.delete(k)); },
    };
    return { getScriptCache: () => cache, _store: store };
}

/** FileIndex 시트 흉내 — getCachedMetadataMap이 쓰는 최소 표면만 */
function makeSpreadsheetApp(CORPUS) {
    const header = ['fileId', '파일명', '폴더경로', 'URL', '수정일'];
    const rows = CORPUS.map(r => [r.fileId, r.name, r.path, r.url, '2026-01-01']);
    const data = [header, ...rows];
    const sheet = {
        getLastRow: () => data.length,
        getMaxRows: () => data.length,
        getRange: (r, c, nr = 1, nc = 1) => ({
            getValues: () => Array.from({ length: nr }, (_, i) => {
                const row = data[r - 1 + i] || [];
                return Array.from({ length: nc }, (_, j) => (row[c - 1 + j] ?? ''));
            }),
            setValues: () => {},
            setNumberFormat: function () { return this; },
            getValue: () => (data[r - 1] || [])[c - 1] ?? '',
        }),
        appendRow: () => {},
    };
    return { openById: () => ({ getSheetByName: (n) => (n === 'FileIndex' ? sheet : null) }) };
}

function loadGas(CORPUS, ROOT) {
    const ctx = {
        Drive: {},
        DriveApp: {},
        SpreadsheetApp: makeSpreadsheetApp(CORPUS),
        CacheService: makeCacheService(),
        PropertiesService: { getScriptProperties: () => ({
            // [fix-13.B4] 색인 시점에 저장되는 루트 폴더 이름
            getProperty: (k) => (k === 'ROOT_FOLDER_NAME' ? ROOT : null),
            setProperty: () => {}, deleteProperty: () => {},
        }) },
        LockService: { getScriptLock: () => ({
            tryLock: () => true, waitLock: () => {}, releaseLock: () => {},
        }) },
        ScriptApp: { newTrigger: () => ({ timeBased: () => ({ after: () => ({ create: () => {} }) }) }),
                     getProjectTriggers: () => [] },
        HtmlService: {},
        Session: { getScriptTimeZone: () => 'Asia/Seoul' },
        Utilities: { formatDate: () => '2026-01-01' },
        Logger: { log: () => {} },
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(CODE_GS, 'utf8'), ctx);

    // 외부 호출만 대체한다. 매칭·정규화·파싱·집합연산은 전부 진짜가 돈다.
    ctx.driveFullTextSearch = () => [];
    ctx.logKeywords = (kws) => { ctx.__logged.push(...kws); };
    ctx.__logged = [];
    return ctx;
}

// ── 테스트 유틸 ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function eq(label, a, b) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa === sb) { passed++; return; }
    failed++;
    console.log(`  \u2717 ${label}`);
    console.log(`      Docker: ${sa}`);
    console.log(`      GAS   : ${sb}`);
}

/** 결과를 순서 무관 비교용 키 집합으로 (GAS는 정렬을 클라이언트가 한다) */
const keyset = (rows) =>
    rows.map(r => `${String(r.name)}|${String(r.path)}|${String(r.url)}`).sort();

function astString(n) {
    if (!n) return 'null';
    if (n.type === 'EMPTY') return 'EMPTY';
    if (n.type === 'KEYWORD') return JSON.stringify(n.value);
    if (n.type === 'NOT') return `NOT(${astString(n.operand)})`;
    return `${n.type}(${astString(n.left)}, ${astString(n.right)})`;
}

const KEY_INPUTS = ['논술', '  논술  ', '"논술"', "'논술'", '""', 'ABC', 'Abc',
                    '논술'.normalize('NFD'), 2027, true, null, undefined, '', '3-1'];

function queriesFor(ROOT) {
    return [
        '논술', '면접', '서울대', '교과',
        '논술 AND 면접', '논술 OR 면접', '논술 NOT 면접',
        'NOT 논술', '(논술 OR 면접) AND 서울대', '논술 AND (면접 OR 교과)',
        '논술 or 면접', '논술 And 면접',
        'android', 'notable', 'oracle',
        '공백 포함 키워드', '서울 대학교',
        '이공계', '기술문서', '학생부',
        ROOT, ROOT.slice(0, 7), '대입자료',          // 루트 전체 / 조각 → 0건이어야 한다
        '2027', '2028',
        '논술'.normalize('NFD'), '논술'.normalize('NFC'),
        '""', "''", '"논술"',
        '논술 AND', '논술 OR', 'AND 논술', '논술 AND AND 면접',
        '(논술', '논술)', '(논술 OR 면접))', '서울대 (논술)',
        '', '   ', 'AND', 'NOT',
        '논술 NOT 존재하지않는키워드',
        '((논술))', '(((면접)))',
    ];
}

// ── 한 세트 실행 ─────────────────────────────────────────────────────────────
async function runSuite(label, ROOT) {
    console.log(`\n── ${label} (루트: ${JSON.stringify(ROOT)}) ──`);
    const CORPUS = makeCorpus(ROOT);
    const G = loadGas(CORPUS, ROOT);

    const DOCKER_INDEX = SK.buildSearchIndex(CORPUS, ROOT);
    const DOCKER_ROWS = new Map(CORPUS.map(r => [r.fileId, r]));
    const dockerIO = (logged) => ({
        // server.js의 getFileIdsForKeyword에서 SQLite 캐시와 Drive만 뺀 것
        resolveKeyword: async (kw) => SK.matchKeyword(DOCKER_INDEX, SK.normalizeKeyword(kw)),
        allIds: () => new Set(CORPUS.map(r => r.fileId)),
        lookup: (id) => DOCKER_ROWS.get(id),
        logKeyword: (kw) => logged.push(kw),
    });

    const QUERIES = queriesFor(ROOT);

    // 1. tokenize
    for (const q of QUERIES) eq(`tokenize(${JSON.stringify(q)})`, tokenize(q), G.tokenize(q));

    // 2. 파서 AST + leftover
    for (const q of QUERIES) {
        const dp = new BooleanParser(tokenize(q)); const dTree = dp.parse();
        const gp = new G.BooleanParser(G.tokenize(q)); const gTree = gp.parse();
        eq(`AST(${JSON.stringify(q)})`,
           { ast: astString(dTree), leftover: dp.pos < dp.tokens.length },
           { ast: astString(gTree), leftover: gp.pos < gp.tokens.length });
    }

    // 3. 정규화·경로 헬퍼
    for (const v of KEY_INPUTS) {
        eq(`normalizeKeyword(${JSON.stringify(v)})`, SK.normalizeKeyword(v), G._normalizeKeyword(v));
        eq(`normKey(${JSON.stringify(v)})`, SK.normKey(v), G._normKey(v));
    }
    for (const v of [`${ROOT}/서울대`, `${ROOT}/서울대/2027`, ROOT, '', null, undefined, 'a/b/c', '/선행슬래시']) {
        eq(`toSearchPath(${JSON.stringify(v)})`, SK.toSearchPath(v, ROOT), G._toSearchPath(v, ROOT));
    }

    // 4. end-to-end: 진짜 doSearch ↔ 진짜 runSearch
    for (const q of QUERIES) {
        const dLogged = [];
        const d = await runSearch(q, dockerIO(dLogged));
        G.__logged = [];
        const g = G.doSearch(q);

        const dShape = d.error ? { error: d.error } : { results: keyset(d.results) };
        const gShape = (g && !Array.isArray(g) && g.error)
            ? { error: g.error }
            : { results: keyset(g) };
        eq(`search(${JSON.stringify(q)})`, dShape, gShape);
        eq(`logged(${JSON.stringify(q)})`, [...dLogged].sort(), [...G.__logged].sort());
    }

    // 5. 루트 폴더명이 결과를 오염시키지 않는지 (양쪽 각각 절대 검증)
    for (const frag of [ROOT, ROOT.slice(0, 7), '대입자료']) {
        const d = await runSearch(frag, dockerIO([]));
        eq(`루트 조각 ${JSON.stringify(frag)} → 0건`,
           { n: d.error ? -1 : d.results.length }, { n: 0 });
    }
}

(async () => {
    // [fix-13.B4] Drive는 폴더명에 '/'를 허용한다. 두 형태 모두에서 같아야 한다.
    await runSuite('일반 루트',     '2027 대입자료');
    await runSuite('슬래시 든 루트', '2027/2028학년도 대입자료');

    console.log(`\n${'─'.repeat(56)}`);
    console.log(`GAS ↔ Docker 대조: 총 ${passed + failed}개 | \u2713 ${passed} | \u2717 ${failed}`);
    if (failed > 0) {
        console.log('\n두 구현이 갈라졌다. 어느 쪽이 옳은지 정한 뒤 양쪽을 함께 고칠 것.');
        process.exit(1);
    }
})();
