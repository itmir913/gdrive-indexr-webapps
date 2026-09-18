// ── GAS ↔ Docker 구현 대조 테스트 ────────────────────────────────────────────
//
// 두 구현(src/Code.gs, docker/backend/*.js)은 같은 앱이라고 주장하지만 소스가 따로다.
// 13차 감사에서 나온 결함 중 1·2·6·13번이 전부 "한쪽에만 있는 동작"이었고,
// BooleanParser.peek()처럼 양쪽 감사가 모두 놓친 차이도 있었다.
//
// 이 파일은 같은 입력을 두 구현에 통과시켜 결과가 어긋나면 실패한다.
// 캐시·Drive·시트는 스텁으로 대체하고, 순수 로직(토크나이즈·파싱·정규화·경로·집합연산)만 본다.
//
// 실행: node test-parity.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const D = {
    ...require('./parser'),
    ...require('./search-keys'),
};

// ── GAS 측 로드 ──────────────────────────────────────────────────────────────
const CODE_GS = path.join(__dirname, '..', '..', 'src', 'Code.gs');

function loadGas() {
    const ctx = {
        // Code.gs가 로드 시점에 참조하는 전역만 최소로 채운다
        Drive: {}, DriveApp: {}, SpreadsheetApp: {}, CacheService: {},
        PropertiesService: {}, LockService: {}, ScriptApp: {}, HtmlService: {},
        Session: {}, Utilities: {},
        Logger: { log: () => {} },
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(CODE_GS, 'utf8'), ctx);
    return ctx;
}

const G = loadGas();

// ── 테스트 유틸 ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function eq(label, a, b) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa === sb) { passed++; console.log(`  ✓ ${label}`); return; }
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      Docker: ${sa}`);
    console.log(`      GAS   : ${sb}`);
}

const sorted = (iter) => [...iter].sort();

// ── 공용 픽스처 ──────────────────────────────────────────────────────────────
// 실제 인덱스처럼 모든 경로가 루트 폴더 이름으로 시작한다.
const ROOT = '2027 대입자료';
const CORPUS = [
    { fileId: 'f1', name: '서울대 수시 논술 2027',  path: `${ROOT}/서울대` },
    { fileId: 'f2', name: '연세대 수시 면접 2027',  path: `${ROOT}/연세대` },
    { fileId: 'f3', name: '고려대 정시 논술 2026',  path: `${ROOT}/고려대` },
    { fileId: 'f4', name: '서울대 정시 교과 2026',  path: `${ROOT}/서울대` },
    { fileId: 'f5', name: '카이스트 논술 면접 2027', path: `${ROOT}/이공계` },
    { fileId: 'f6', name: 'android 개발 가이드',     path: `${ROOT}/기술문서` },
    { fileId: 'f7', name: 'notable 키워드 테스트',   path: `${ROOT}/기술문서` },
    { fileId: 'f8', name: 'oracle 데이터베이스',     path: `${ROOT}/기술문서` },
    { fileId: 'f9', name: '교과 중심 학생부 전형',   path: `${ROOT}/학생부` },
    { fileId: 'fA', name: '논술 자료'.normalize('NFD'), path: `${ROOT}/서울대`.normalize('NFD') },
    { fileId: 'fB', name: 2027,  path: `${ROOT}/기타` },   // 시트가 숫자로 돌려준 경우
    { fileId: 'fC', name: '공백 포함 키워드 문서',   path: ROOT },            // 루트 직속
];
const ALL_IDS = CORPUS.map(r => r.fileId);

// Drive fullText 검색은 양쪽 모두 외부 호출이므로 대조 대상에서 제외한다(빈 결과로 고정).
// 남는 것은 이름·경로 매칭 = 두 구현이 반드시 같아야 하는 부분.

// GAS 쪽 키워드 해결을 픽스처 기반으로 교체
G.getFileIdsForKeyword = function (keyword) {
    const kw = G._normalizeKeyword(keyword);
    if (!kw) return [];
    return CORPUS
        .filter(r => G._normKey(r.name).includes(kw) ||
                     G._normKey(G._toSearchPath(r.path)).includes(kw))
        .map(r => r.fileId);
};
G.getAllFileIds = () => new Set(ALL_IDS);

// Docker 쪽 동일 경로
const DOCKER_INDEX = D.buildSearchIndex(CORPUS);
function dockerSearch(query) {
    const tokens = D.tokenize(query);
    const parser = new D.BooleanParser(tokens);
    const tree = parser.parse();
    if (parser.pos < parser.tokens.length) return { leftover: true };

    const collect = (n, acc = new Set()) => {
        if (!n || n.type === 'EMPTY') return acc;
        if (n.type === 'KEYWORD') { acc.add(n.value); return acc; }
        if (n.type === 'NOT') return collect(n.operand, acc);
        collect(n.left, acc); collect(n.right, acc); return acc;
    };
    const map = new Map();
    for (const kw of collect(tree)) {
        map.set(kw, new Set(D.matchKeyword(DOCKER_INDEX, D.normalizeKeyword(kw))));
    }
    return { set: D.evaluate(tree, map, new Set(ALL_IDS)) };
}

function gasSearch(query) {
    const tokens = G.tokenize(query);
    const parser = new G.BooleanParser(tokens);
    const tree = parser.parse();
    if (parser.pos < parser.tokens.length) return { leftover: true };
    return { set: G.evaluate(tree, new Set(ALL_IDS)) };
}

// ── 대조 대상 질의 ───────────────────────────────────────────────────────────
const QUERIES = [
    '논술', '면접', '서울대', '교과',
    '논술 AND 면접', '논술 OR 면접', '논술 NOT 면접',
    'NOT 논술', '(논술 OR 면접) AND 서울대', '논술 AND (면접 OR 교과)',
    '논술 or 면접', '논술 And 면접',                 // 연산자 대소문자
    'android', 'notable', 'oracle',                  // 연산자 부분 문자열
    '공백 포함 키워드', '서울 대학교',                 // 공백 포함 키워드
    '이공계', '기술문서', '학생부',                    // 하위 폴더명
    ROOT, '2027 대입', '대입자료',                     // 루트 폴더명 (0건이어야 함)
    '2027',                                           // 숫자형 파일명 + 파일명 내 숫자
    '논술'.normalize('NFD'), '논술'.normalize('NFC'),  // 유니코드 정규화
    '""', "''", '"논술"',                              // 따옴표
    '논술 AND', '논술 OR', 'AND 논술', '논술 AND AND 면접',  // 비정상 연산자
    '(논술', '논술)', '(논술 OR 면접))', '서울대 (논술)',    // 괄호
    '', '   ', 'AND', 'NOT',                           // 공백·단독 연산자
    '논술 NOT 존재하지않는키워드',
    '((논술))', '(((면접)))',
];

// ── 1. tokenize 대조 ─────────────────────────────────────────────────────────
console.log('\n[1] tokenize 대조');
for (const q of QUERIES) {
    eq(`tokenize(${JSON.stringify(q)})`, D.tokenize(q), G.tokenize(q));
}

// ── 2. 파서 AST 대조 ─────────────────────────────────────────────────────────
console.log('\n[2] 파서 AST + leftover 대조');
function astString(n) {
    if (!n) return 'null';
    if (n.type === 'EMPTY') return 'EMPTY';
    if (n.type === 'KEYWORD') return JSON.stringify(n.value);
    if (n.type === 'NOT') return `NOT(${astString(n.operand)})`;
    return `${n.type}(${astString(n.left)}, ${astString(n.right)})`;
}
for (const q of QUERIES) {
    const dp = new D.BooleanParser(D.tokenize(q));
    const dTree = dp.parse();
    const gp = new G.BooleanParser(G.tokenize(q));
    const gTree = gp.parse();
    eq(`AST(${JSON.stringify(q)})`,
       { ast: astString(dTree), leftover: dp.pos < dp.tokens.length },
       { ast: astString(gTree), leftover: gp.pos < gp.tokens.length });
}

// ── 3. 정규화 헬퍼 대조 ──────────────────────────────────────────────────────
console.log('\n[3] 정규화·경로 헬퍼 대조');
const KEY_INPUTS = ['논술', '  논술  ', '"논술"', "'논술'", '""', 'ABC', 'Abc',
                    '논술'.normalize('NFD'), 2027, true, null, undefined, '', '3-1'];
for (const v of KEY_INPUTS) {
    eq(`normalizeKeyword(${JSON.stringify(v)})`, D.normalizeKeyword(v), G._normalizeKeyword(v));
    eq(`normKey(${JSON.stringify(v)})`, D.normKey(v), G._normKey(v));
}
const PATH_INPUTS = [`${ROOT}/서울대`, `${ROOT}/서울대/2027`, ROOT, '', null, undefined,
                     'a/b/c', '/선행슬래시'];
for (const v of PATH_INPUTS) {
    eq(`toSearchPath(${JSON.stringify(v)})`, D.toSearchPath(v), G._toSearchPath(v));
}

// ── 4. 검색 결과 집합 대조 (end-to-end) ──────────────────────────────────────
console.log('\n[4] 검색 결과 대조 (파일명 + 하위 폴더 경로)');
for (const q of QUERIES) {
    const d = dockerSearch(q);
    const g = gasSearch(q);
    eq(`search(${JSON.stringify(q)})`,
       d.leftover ? { leftover: true } : { ids: sorted(d.set) },
       g.leftover ? { leftover: true } : { ids: sorted(g.set) });
}

// ── 결과 ─────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(56)}`);
console.log(`GAS ↔ Docker 대조: 총 ${passed + failed}개 | ✓ ${passed} | ✗ ${failed}`);
if (failed > 0) {
    console.log('\n두 구현이 갈라졌다. 어느 쪽이 옳은지 정한 뒤 양쪽을 함께 고칠 것.');
    process.exit(1);
}
