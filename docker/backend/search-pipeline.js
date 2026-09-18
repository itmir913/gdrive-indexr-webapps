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

const QUERY_ERROR    = '잘못된 검색식입니다. 괄호를 확인하세요.';
const NEGATIVE_ONLY  = '제외(NOT) 조건만으로는 검색할 수 없습니다. 찾으려는 키워드를 함께 입력해 주세요.';
const SHORT_KEYWORD  = '검색어는 두 글자 이상 입력해 주세요.';
const MIN_KEYWORD_LENGTH = 2;

// [fix-13.B8] 순수 부정 질의 판정.
//   `NOT 없는키워드`는 전체 파일 목록을 한 번에 돌려준다. 11차 F16이 "전체 목록 노출
//   방지"를 정책으로 세웠는데 이 경로가 그 정책의 구멍으로 남아 있었다.
//   (엔드포인트가 공개라 이것만으로 열거를 막지는 못한다 — 정책 일관성을 위한 차단이다.
//    실제 열거 방지는 접근 제어의 몫이고, 이 프로젝트는 공개 모델을 택했다.)
//   판정 규칙: NOT은 여집합을 만든다. AND는 한쪽이라도 양성이면 좁혀지므로 안전하고,
//   OR은 한쪽이라도 음성이면 넓어지므로 위험하다. EMPTY는 공집합이라 확장하지 않는다.
//   → `논술 NOT 면접` 통과 / `NOT 면접`, `NOT A OR B` 차단
function isPureNegative(node) {
    if (!node || node.type === 'EMPTY') return false;
    if (node.type === 'KEYWORD') return false;
    // [fix-13.C1] 이중 부정은 여집합의 여집합이라 다시 양성이다. `true`로 두면
    //   `NOT NOT 논술`이 차단되는데, evaluate는 이를 `논술`과 같게 계산한다
    //   (test-parser.js의 "NOT NOT 논술 = 논술" 케이스와 엔드포인트가 어긋났다).
    if (node.type === 'NOT') return !isPureNegative(node.operand);
    if (node.type === 'AND') return isPureNegative(node.left) && isPureNegative(node.right);
    if (node.type === 'OR')  return isPureNegative(node.left) || isPureNegative(node.right);
    return false;
}

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

    // [fix-13.B8] 순수 부정 질의는 전체 목록을 반환한다 — F16 정책의 구멍이었다
    if (isPureNegative(tree)) return { error: NEGATIVE_ONLY };

    const keywords = [...extractKeywords(tree)];
    // [fix-F16] 키워드가 없는 질의(빈 괄호 등) 차단
    if (keywords.length === 0) return { results: [] };

    // [fix-13.B8] 최소 길이 검증. 프론트에만 있던 2글자 제한을 서버에도 둔다.
    //   한 글자("0", "대")면 부분 문자열 매칭이 사실상 전 파일에 걸린다(측정: 100%).
    if (keywords.some(kw => normalizeKeyword(kw).length < MIN_KEYWORD_LENGTH)) {
        return { error: SHORT_KEYWORD };
    }

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
        // 정규화 후 중복 제거 — `논술 OR "논술"`은 같은 키워드다.
        // (GAS는 정규화한 뒤 Set에 담으므로 여기서도 같게 맞춘다)
        new Set(keywords.map(normalizeKeyword)).forEach(norm => {
            if (norm) io.logKeyword(norm);
        });
    }

    return { results };
}

module.exports = {
    runSearch, extractKeywords, isPureNegative,
    QUERY_ERROR, NEGATIVE_ONLY, SHORT_KEYWORD, MIN_KEYWORD_LENGTH,
};
