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
//            부분 문자열(연도·학교명 등)이 전 파일에 걸리므로 루트 세그먼트를 뗀다.
// [fix-13.B4] 루트 이름을 알면 정확한 접두사로 제거한다. Drive는 폴더명에 '/'를
//             허용하므로("2027/2028학년도 대입자료") 첫 '/'로 자르면 루트의 뒷부분이
//             경로에 남아 같은 버그가 재발한다. rootName이 없을 때만 옛 방식으로 되돌린다.
function toSearchPath(path, rootName) {
    // [fix-13.B4] 접두사 비교 전에 양쪽을 NFC로 맞춘다. macOS 업로드 경로는 NFD라
    //             정규화 전에 비교하면 루트 접두사가 안 맞아 전체 경로가 그대로 남고,
    //             결국 루트 이름 조각이 다시 전 파일에 걸린다.
    const s = String(path ?? '').normalize('NFC');
    const root = String(rootName ?? '').normalize('NFC');
    if (root) {
        if (s === root) return '';
        if (s.startsWith(root + '/')) return s.slice(root.length + 1);
        return s;   // 루트 밖의 경로 — 그대로 둔다
    }
    const i = s.indexOf('/');
    return i === -1 ? '' : s.slice(i + 1);
}

// file_index 행 → 정규화된 검색 키. 응답 본문과 분리해 두어 결과 JSON을 오염시키지 않는다.
function buildSearchIndex(rows, rootName) {
    return rows.map(row => ({
        id     : row.fileId,
        nameKey: normKey(row.name),
        pathKey: normKey(toSearchPath(row.path, rootName)),
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
