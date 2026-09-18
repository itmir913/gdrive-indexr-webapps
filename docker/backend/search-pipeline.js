// ── 검색 파이프라인 ─────────────────────────────────────────────────────────
// [fix-13.B1] /api/search 핸들러 안에만 있던 흐름을 순수 함수로 분리한다.
//             대조 테스트(test-parity.js)가 핸들러의 사본을 재구현하는 한, 응답 형태·
//             F16 가드·키워드 로깅 순서 같은 것들이 GAS와 갈라져도 테스트는 통과한다.
//             13차 감사에서 지적된 2번·6번이 정확히 그 사각지대에 있었다.
//
// I/O(캐시·Drive·DB)는 전부 주입받는다. 이 파일에는 부수효과가 없다.

const { tokenize, BooleanParser, evaluate } = require('./parser');
const { normalizeKeyword } = require('./search-keys');

/** AST에서 키워드 추출 */
function extractKeywords(node) {
    if (!node || node.type === 'EMPTY') return new Set();
    if (node.type === 'KEYWORD') return new Set([node.value]);
    if (node.type === 'NOT') return extractKeywords(node.operand);
    return new Set([...extractKeywords(node.left), ...extractKeywords(node.right)]);
}

const QUERY_ERROR = '잘못된 검색식입니다. 괄호를 확인하세요.';

/**
 * @param {string}   query         원본 질의
 * @param {object}   io
 * @param {function} io.resolveKeyword  (keyword) => Promise<string[]>  키워드 → fileId 배열
 * @param {function} io.allIds          () => Set<string>               전체 fileId (NOT 연산용)
 * @param {function} io.lookup          (id) => object|undefined        fileId → 메타데이터 행
 * @param {function} [io.logKeyword]    (normalizedKeyword) => void     검증 통과 후에만 호출된다
 * @returns {Promise<{error: string}|{results: object[]}>}
 */
async function runSearch(query, io) {
    query = String(query ?? '').trim();
    if (!query) return { results: [] };

    const tokens = tokenize(query);
    const parser = new BooleanParser(tokens);
    const tree = parser.parse();

    // [fix-13.6] 소비되지 않은 토큰이 남으면 잘못된 검색식이다. GAS doSearch와 같은 형태로 알린다.
    if (parser.pos < parser.tokens.length) return { error: QUERY_ERROR };

    const keywords = [...extractKeywords(tree)];
    // [fix-F16] 키워드가 없는 질의(순수 연산자 등) 차단 — NOT(EMPTY)로 전체 목록이 노출된다
    if (keywords.length === 0) return { results: [] };

    const fileIdArrays = await Promise.all(keywords.map(kw => io.resolveKeyword(kw)));
    const keywordMap = new Map();
    keywords.forEach((kw, i) => keywordMap.set(kw, new Set(fileIdArrays[i])));

    const resultSet = evaluate(tree, keywordMap, io.allIds());

    const results = Array.from(resultSet)
        .map(id => io.lookup(id))
        .filter(Boolean)
        .sort((a, b) =>
            String(a.path ?? '').localeCompare(String(b.path ?? ''), 'ko') ||
            String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ko'));

    // [fix-13.13] 로깅은 검증을 통과한 뒤에만. 오타 질의의 키워드가 로그를 오염시키면
    //             warmCache가 그것으로 Drive를 검색한다.
    if (io.logKeyword) {
        keywords.forEach(kw => {
            const norm = normalizeKeyword(kw);
            if (norm) io.logKeyword(norm);
        });
    }

    return { results };
}

module.exports = { runSearch, extractKeywords, QUERY_ERROR };
