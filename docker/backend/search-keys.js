// ── 검색 키 정규화 ───────────────────────────────────────────────────────────
// [fix-13.2] 이 로직이 server.js 안에만 있었던 탓에 test-parser.js가 별도 사본을
//            들고 있었고, 그 사본이 실제 동작과 갈라져 "루트 폴더명 부분 문자열이
//            전 파일에 걸리는" 버그를 12차 감사까지 놓쳤다. 단일 모듈로 분리해
//            서버와 테스트가 반드시 같은 구현을 쓰게 한다.

// [fix-13.5]  시트·DB가 숫자/날짜를 돌려줄 수 있으므로 String()으로 감싼다.
// [fix-13.11] macOS 업로드 파일명은 한글이 NFD라 NFC 검색어와 코드 포인트가 다르다.
const normKey = (s) => String(s ?? '').normalize('NFC').toLowerCase();

// 캐시 키·keyword_log·검색이 모두 같은 형태를 쓰도록 단일 함수로 관리
const normalizeKeyword = (kw) => normKey(kw).replace(/['"]/g, '').trim();

// [fix-13.2] 모든 path는 루트 폴더 이름으로 시작한다. 그대로 매칭하면 루트 이름의
//            부분 문자열(연도·학교명 등)이 전 파일에 걸리므로 첫 세그먼트를 뗀다.
function toSearchPath(path) {
    const s = String(path ?? '');
    const i = s.indexOf('/');
    return i === -1 ? '' : s.slice(i + 1);
}

// file_index 행 → 정규화된 검색 키. 응답 본문과 분리해 두어 결과 JSON을 오염시키지 않는다.
function buildSearchIndex(rows) {
    return rows.map(row => ({
        id     : row.fileId,
        nameKey: normKey(row.name),
        pathKey: normKey(toSearchPath(row.path)),
    }));
}

// 파일명 + 하위 폴더 경로에서 키워드를 찾아 fileId 배열을 돌려준다.
function matchKeyword(searchIndex, keyword) {
    // [fix-13.10] 빈 키워드는 includes('')로 전건 매칭되므로 여기서 끊는다.
    if (!keyword) return [];
    const results = [];
    for (const entry of searchIndex) {
        if (entry.nameKey.includes(keyword) || entry.pathKey.includes(keyword)) {
            results.push(entry.id);
        }
    }
    return results;
}

module.exports = { normKey, normalizeKeyword, toSearchPath, buildSearchIndex, matchKeyword };
