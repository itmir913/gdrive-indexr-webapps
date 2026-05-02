const { tokenize, BooleanParser, evaluate } = require('./parser');

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
    const keywordMap = new Map();
    for (const kw of keywords) {
        const ids = [];
        for (const [id, file] of fileMap) {
            if (file.name.toLowerCase().includes(kw) || (file.path || '').toLowerCase().includes(kw)) {
                ids.push(id);
            }
        }
        keywordMap.set(kw, new Set(ids));
    }
    const allIds = new Set(fileMap.keys());
    return evaluate(tree, keywordMap, allIds);
}

// ── 파일 데이터셋 ─────────────────────────────────────────────────────────────
const files = new Map([
    ['f1', { name: '서울대 수시 논술 2027', path: '서울대' }],
    ['f2', { name: '연세대 수시 면접 2027', path: '연세대' }],
    ['f3', { name: '고려대 정시 논술 2026', path: '고려대' }],
    ['f4', { name: '서울대 정시 교과 2026', path: '서울대' }],
    ['f5', { name: '카이스트 논술 면접 2027', path: '이공계' }],
    ['f6', { name: 'android 개발 가이드', path: '기술문서' }],       // 'and' 포함
    ['f7', { name: 'notable 키워드 테스트', path: '기술문서' }],      // 'not' 포함
    ['f8', { name: 'oracle 데이터베이스', path: '기술문서' }],        // 'or' 포함
    ['f9', { name: '교과 중심 학생부 전형', path: '학생부' }],
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

// ── 결과 ─────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`총 ${passed + failed}개 | ✓ ${passed}개 통과 | ✗ ${failed}개 실패`);
if (failed > 0) process.exit(1);
