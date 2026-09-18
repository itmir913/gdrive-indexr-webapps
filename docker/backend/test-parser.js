const { tokenize, BooleanParser, evaluate } = require('./parser');
// [fix-13.2] 예전에는 이 파일이 매칭 로직 사본을 들고 있어서 server.js와 갈라져도
//            테스트가 통과했다. 이제 서버와 같은 구현을 직접 가져다 쓴다.
const { normalizeKeyword, buildSearchIndex, matchKeyword } = require('./search-keys');

// ── 테스트 유틸 ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(label, actual, expected) {
    const a = JSON.stringify([...actual].sort());
    const e = JSON.stringify([...expected].sort());
    if (a === e) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.error(`  ✗ ${label}`);
        console.error(`    expected: ${e}`);
        console.error(`    actual:   ${a}`);
        failed++;
    }
}

function assertTokens(label, query, expected) {
    const actual = tokenize(query);
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.error(`  ✗ ${label}`);
        console.error(`    expected: ${e}`);
        console.error(`    actual:   ${a}`);
        failed++;
    }
}

// query → evaluate 결과(Set) 반환 헬퍼
function search(query, fileMap) {
    const tokens = tokenize(query);
    const tree = new BooleanParser(tokens).parse();

    // extractKeywords (server.js에서 복사)
    function extractKeywords(node) {
        if (!node || node.type === 'EMPTY') return new Set();
        if (node.type === 'KEYWORD') return new Set([node.value]);
        if (node.type === 'NOT') return extractKeywords(node.operand);
        return new Set([...extractKeywords(node.left), ...extractKeywords(node.right)]);
    }

    const keywords = [...extractKeywords(tree)];
    // server.js의 loadIndexToMemory / getNameMatches와 동일 경로
    const idx = buildSearchIndex(
        [...fileMap].map(([id, f]) => ({ fileId: id, name: f.name, path: f.path }))
    );
    const keywordMap = new Map();
    for (const kw of keywords) {
        keywordMap.set(kw, new Set(matchKeyword(idx, normalizeKeyword(kw))));
    }
    const allIds = new Set(fileMap.keys());
    return evaluate(tree, keywordMap, allIds);
}

// ── 파일 데이터셋 ─────────────────────────────────────────────────────────────
// [fix-13.2] 실제 인덱스처럼 모든 path가 루트 폴더 이름으로 시작하게 둔다.
//            예전 데이터셋은 공통 루트가 없어서 경로 매칭 버그가 드러나지 않았다.
const ROOT = '2027 대입자료';
const files = new Map([
    ['f1', { name: '서울대 수시 논술 2027', path: `${ROOT}/서울대` }],
    ['f2', { name: '연세대 수시 면접 2027', path: `${ROOT}/연세대` }],
    ['f3', { name: '고려대 정시 논술 2026', path: `${ROOT}/고려대` }],
    ['f4', { name: '서울대 정시 교과 2026', path: `${ROOT}/서울대` }],
    ['f5', { name: '카이스트 논술 면접 2027', path: `${ROOT}/이공계` }],
    ['f6', { name: 'android 개발 가이드', path: `${ROOT}/기술문서` }],       // 'and' 포함
    ['f7', { name: 'notable 키워드 테스트', path: `${ROOT}/기술문서` }],      // 'not' 포함
    ['f8', { name: 'oracle 데이터베이스', path: `${ROOT}/기술문서` }],        // 'or' 포함
    ['f9', { name: '교과 중심 학생부 전형', path: `${ROOT}/학생부` }],
]);

// ── 1. tokenize 검증 ──────────────────────────────────────────────────────────
console.log('\n[1] tokenize 검증');

assertTokens('단순 키워드', '논술', ['논술']);
assertTokens('AND 연산자', '논술 AND 면접', ['논술', 'AND', '면접']);
assertTokens('OR 연산자', '논술 OR 면접', ['논술', 'OR', '면접']);
assertTokens('NOT 연산자', 'NOT 교과', ['NOT', '교과']);
assertTokens('소문자 and', '논술 and 면접', ['논술', 'AND', '면접']);
assertTokens('소문자 or', '논술 or 면접', ['논술', 'OR', '면접']);
assertTokens('소문자 not', '논술 not 교과', ['논술', 'NOT', '교과']);
assertTokens('대소문자 혼합', '논술 And 면접', ['논술', 'AND', '면접']);
assertTokens('괄호', '(논술 OR 면접) AND 서울대', ['(', '논술', 'OR', '면접', ')', 'AND', '서울대']);
assertTokens('중첩 괄호', '(A AND (B OR C))', ['(', 'a', 'AND', '(', 'b', 'OR', 'c', ')', ')']);
assertTokens('android — and 부분 문자열 미분리', 'android', ['android']);
assertTokens('notable — not 부분 문자열 미분리', 'notable', ['notable']);
assertTokens('oracle — or 부분 문자열 미분리', 'oracle', ['oracle']);
assertTokens('android AND 논술', 'android AND 논술', ['android', 'AND', '논술']);
assertTokens('공백 여러개', '논술  AND  면접', ['논술', 'AND', '면접']);
assertTokens('앞뒤 공백', '  논술 AND 면접  ', ['논술', 'AND', '면접']);
assertTokens('빈 문자열', '', []);

// ── 2. 단순 키워드 검색 ───────────────────────────────────────────────────────
console.log('\n[2] 단순 키워드 검색');

assert('논술', search('논술', files), ['f1', 'f3', 'f5']);
assert('면접', search('면접', files), ['f2', 'f5']);
assert('서울대', search('서울대', files), ['f1', 'f4']);
assert('2027', search('2027', files), ['f1', 'f2', 'f5']);
assert('android (부분문자열 and 미분리)', search('android', files), ['f6']);
assert('notable (부분문자열 not 미분리)', search('notable', files), ['f7']);
assert('oracle (부분문자열 or 미분리)', search('oracle', files), ['f8']);

// ── 3. AND 연산 ───────────────────────────────────────────────────────────────
console.log('\n[3] AND 연산');

assert('논술 AND 서울대', search('논술 AND 서울대', files), ['f1']);
assert('논술 AND 2027', search('논술 AND 2027', files), ['f1', 'f5']);
assert('논술 AND 면접', search('논술 AND 면접', files), ['f5']);
assert('논술 AND 없는키워드', search('논술 AND 없는키워드', files), []);
assert('A AND B AND C', search('논술 AND 면접 AND 2027', files), ['f5']);

// ── 4. OR 연산 ────────────────────────────────────────────────────────────────
console.log('\n[4] OR 연산');

assert('논술 OR 면접', search('논술 OR 면접', files), ['f1', 'f2', 'f3', 'f5']);
assert('서울대 OR 연세대', search('서울대 OR 연세대', files), ['f1', 'f2', 'f4']);
assert('없는것 OR 없는것2', search('없는것 OR 없는것2', files), []);
assert('A OR B OR C', search('논술 OR 면접 OR 교과', files), ['f1', 'f2', 'f3', 'f4', 'f5', 'f9']);

// ── 5. NOT 연산 ───────────────────────────────────────────────────────────────
console.log('\n[5] NOT 연산');

assert('논술 NOT 서울대', search('논술 NOT 서울대', files), ['f3', 'f5']);
assert('논술 NOT 2027', search('논술 NOT 2027', files), ['f3']);
assert('논술 NOT 없는키워드 (전체 반환)', search('논술 NOT 없는키워드', files), ['f1', 'f3', 'f5']);

// ── 6. 괄호 그룹 ──────────────────────────────────────────────────────────────
console.log('\n[6] 괄호 그룹');

assert('(논술 OR 면접) AND 2027', search('(논술 OR 면접) AND 2027', files), ['f1', 'f2', 'f5']);
assert('(논술 OR 면접) AND 서울대', search('(논술 OR 면접) AND 서울대', files), ['f1']);
assert('서울대 AND (수시 OR 정시)', search('서울대 AND (수시 OR 정시)', files), ['f1', 'f4']);
assert('(서울대 OR 연세대) AND (논술 OR 면접)', search('(서울대 OR 연세대) AND (논술 OR 면접)', files), ['f1', 'f2']);
assert('중첩: (A OR (B AND C))', search('(서울대 OR (연세대 AND 면접))', files), ['f1', 'f2', 'f4']);

// ── 7. 복합 연산 (우선순위) ────────────────────────────────────────────────────
console.log('\n[7] 복합 연산 — 연산자 우선순위 (NOT > AND > OR)');

assert('논술 AND NOT 교과', search('논술 AND NOT 교과', files), ['f1', 'f3', 'f5']);
assert('논술 OR 면접 AND 서울대 (AND 우선)', search('논술 OR 면접 AND 서울대', files), ['f1', 'f3', 'f5']);
assert('(논술 OR 면접) AND 서울대 (괄호 우선)', search('(논술 OR 면접) AND 서울대', files), ['f1']);
assert('NOT NOT 논술 = 논술', search('NOT NOT 논술', files), ['f1', 'f3', 'f5']);

// ── 8. 엣지 케이스 ────────────────────────────────────────────────────────────
console.log('\n[8] 엣지 케이스');

assert('단일 NOT', search('NOT 논술', files), ['f2', 'f4', 'f6', 'f7', 'f8', 'f9']);
assert('존재하지 않는 키워드', search('없는키워드', files), []);
assert('대소문자 무시', search('ANDROID', files), ['f6']);
assert('빈 괄호 → 빈 결과', search('()', files), []);

// ── 9. 추가 토크나이즈 검증 (부분 문자열 경계) ───────────────────────────────
console.log('\n[9] 추가 토크나이즈 검증 — and/or/not 부분 포함 단어');

assertTokens('standard — and 단어 중간',   'standard',   ['standard']);
assertTokens('border — or 단어 중간',       'border',     ['border']);
assertTokens('candidate — and 단어 중간',   'candidate',  ['candidate']);
assertTokens('north — or 단어 중간',        'north',      ['north']);
assertTokens('random — and 단어 중간',      'random',     ['random']);
assertTokens('format — or 단어 중간',       'format',     ['format']);
assertTokens('snorkel — or 단어 중간',      'snorkel',    ['snorkel']);

// ── 10. 연속 연산자 / 트레일링 연산자 ───────────────────────────────────────
console.log('\n[10] 연속 연산자 / 트레일링 연산자 동작 확인');

// 연속 AND: AND(논술, EMPTY) → 빈 집합 ('면접' 토큰은 소비되지 않음)
assertTokens('연속 AND 토크나이즈', '논술 AND AND 면접', ['논술', 'AND', 'AND', '면접']);
assert('논술 AND AND 면접 → 빈 결과', search('논술 AND AND 면접', files), []);

// 연속 OR: OR(논술, EMPTY) → 논술 결과만 ('면접' 토큰은 소비되지 않음)
assertTokens('연속 OR 토크나이즈', '논술 OR OR 면접', ['논술', 'OR', 'OR', '면접']);
assert('논술 OR OR 면접 → 논술 결과만', search('논술 OR OR 면접', files), ['f1', 'f3', 'f5']);

// 트레일링 AND: AND(논술, EMPTY) → 빈 집합
assertTokens('트레일링 AND 토크나이즈', '논술 AND', ['논술', 'AND']);
assert('논술 AND → 빈 결과', search('논술 AND', files), []);

// 트레일링 OR: OR(논술, EMPTY) → 논술 결과
assertTokens('트레일링 OR 토크나이즈', '논술 OR', ['논술', 'OR']);
assert('논술 OR → 논술 결과', search('논술 OR', files), ['f1', 'f3', 'f5']);

// ── 11. 13차 감사 회귀 테스트 ────────────────────────────────────────────────
console.log('\n[11] 13차 감사 회귀 (경로 매칭 / 빈 키워드 / 유니코드 정규화)');

// [fix-13.2] 루트 폴더 이름 조각은 전 파일에 걸리면 안 된다
assert('루트 폴더명 전체는 매칭 안 됨', search(ROOT, files), []);
assert('루트 폴더명 조각 "2027 대입"은 매칭 안 됨', search('2027 대입', files), []);
assert('"대입"은 파일명에도 없으므로 0건', search('대입', files), []);
// 하위 폴더 이름은 계속 검색돼야 한다 (사용자 선택: 파일명 + 하위 폴더 경로)
assert('하위 폴더명 "이공계" 검색', search('이공계', files), ['f5']);
assert('하위 폴더명 "기술문서" 검색', search('기술문서', files), ['f6', 'f7', 'f8']);
assert('하위 폴더명 + 파일명 혼합 (기술문서 AND oracle)',
       search('기술문서 AND oracle', files), ['f8']);

// [fix-13.10] 따옴표만 있는 질의가 전체 목록을 반환하면 안 된다
assert('빈 키워드는 전건 매칭 금지', matchKeyword(buildSearchIndex(
    [...files].map(([id, f]) => ({ fileId: id, name: f.name, path: f.path }))), ''), []);
assert('normalizeKeyword(\'""\') → 빈 문자열',
       [normalizeKeyword('""')], ['']);
assert('따옴표 질의는 0건', search('""', files), []);

// [fix-13.11] NFD로 저장된 파일명도 NFC 검색어로 찾혀야 한다
const nfdFiles = new Map([
    ['n1', { name: '논술 자료'.normalize('NFD'), path: `${ROOT}/서울대`.normalize('NFD') }],
]);
assert('NFD 파일명을 NFC 검색어로 매칭', search('논술', nfdFiles), ['n1']);

// [fix-13.5] 시트/DB가 숫자·날짜를 돌려줘도 죽지 않아야 한다
const coercedFiles = new Map([
    ['c1', { name: 2027, path: `${ROOT}/서울대` }],
    ['c2', { name: true, path: null }],
]);
assert('숫자 파일명 매칭 (TypeError 없이)', search('2027', coercedFiles), ['c1']);
assert('null 경로에서도 안전', search('서울대', coercedFiles), ['c1']);

// ── 결과 ─────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`총 ${passed + failed}개 | ✓ ${passed}개 통과 | ✗ ${failed}개 실패`);
if (failed > 0) process.exit(1);
