// ── 상수 ────────────────────────────────────────────────────────────────────
const FOLDER_ID           = 'your_root_folder_id';
const INDEX_SHEET_ID      = 'your_spreadsheet_id';
const ADMIN_PASSWORD      = 'admin1234';   // 실제 사용할 비밀번호로 변경하세요. 편의를 위해 평문으로 작성해도 됩니다.

const FILE_INDEX_SHEET    = 'FileIndex';   // 파일 메타데이터 인덱스 시트 이름
const KEYWORD_LOG_SHEET   = 'KeywordLog';  // 키워드 빈도 로그 시트 이름
const CACHE_TTL           = 21600;         // 6시간 (Google 하드 리밋)
const PRECACHE_TOP_N      = 100;           // warmCache 사전 워밍 대상 상위 N개; 나머지는 첫 검색 시 온디맨드 캐싱
const DRIVE_SERVICE       = Drive;         // Apps Script 서비스 식별자 (편집기 → 서비스 → 식별자)

// ── 진입점 ───────────────────────────────────────────────────────────────────
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('입시자료 통합검색');
}

// ── 검색 메인 (google.script.run 호출점) ────────────────────────────────────
function doSearch(query) {
  try {
    query = (query || '').trim();
    if (!query) return [];

    const tokens = tokenize(query);

    // 로깅용 키워드 추출 (연산자·괄호 제외)
    const keywords = tokens
      .filter(t => t.type === 'KEYWORD')
      .map(t => t.value);
    logKeywords(keywords);

    const tree      = buildExpressionTree(tokens);
    const resultSet = evaluate(tree);
    if (resultSet.size === 0) return [];

    return lookupMetadata([...resultSet]);
  } catch (err) {
    Logger.log('doSearch error: ' + err.message);
    return [];
  }
}

// ── 키워드 빈도 로그 (KEYWORD_LOG_SHEET) ────────────────────────────────────────────────
function logKeywords(keywords) {
  if (!keywords || keywords.length === 0) return;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    return; // 잠금 실패 시 로깅 skip, 검색은 계속
  }

  try {
    const ss    = SpreadsheetApp.openById(INDEX_SHEET_ID);
    const sheet = ss.getSheetByName(KEYWORD_LOG_SHEET);
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

    // 전체 읽기
    const lastRow = sheet.getLastRow();
    let rows;
    if (lastRow < 1) {
      rows = [['키워드', '검색횟수', '마지막검색일']];
    } else {
      rows = sheet.getRange(1, 1, lastRow, 3).getValues();
    }

    // 헤더가 없으면 삽입
    if (rows[0][0] !== '키워드') {
      rows.unshift(['키워드', '검색횟수', '마지막검색일']);
    }

    // Map 구성 (헤더 제외)
    const keyMap = {};
    for (let i = 1; i < rows.length; i++) {
      keyMap[rows[i][0]] = i;
    }

    keywords.forEach(kw => {
      if (kw in keyMap) {
        const idx = keyMap[kw];
        rows[idx][1] = parseInt(rows[idx][1], 10) + 1;
        rows[idx][2] = today;
      } else {
        rows.push([kw, 1, today]);
        keyMap[kw] = rows.length - 1;
      }
    });

    sheet.clearContents();
    sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  } finally {
    lock.releaseLock();
  }
}

// ── 키워드 → fileId 배열 (캐시 우선) ────────────────────────────────────────
function getFileIdsForKeyword(keyword) {
  keyword = keyword.toLowerCase().trim();
  const cacheKey = 'kw_' + keyword;
  const cache = CacheService.getScriptCache();

  const cached = cache.get(cacheKey);
  if (cached !== null) return JSON.parse(cached);

  const driveIds = driveFullTextSearch(keyword);      // 1. 드라이브 전체 텍스트 검색 (내용 중심)
  const sheetIds = getNameMatchesFromSheet(keyword);  // 2. 스프레드시트 인덱스에서 파일명 검색 (파일명 중심)
  const combinedIds = [...new Set([...driveIds, ...sheetIds])];  // 3. 두 결과 합치기 (중복 제거)

  cache.put(cacheKey, JSON.stringify(combinedIds), CACHE_TTL);
  return combinedIds;
}

// ── 시트 인덱스에서 파일명으로 ID를 찾아주는 헬퍼 함수 ──────────────────
function getNameMatchesFromSheet(keyword) {
  const ss = SpreadsheetApp.openById(INDEX_SHEET_ID);
  const sheet = ss.getSheetByName(FILE_INDEX_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // [데이터 가져오기]
  // getRange(시작 행, 시작 열, 행 개수, 열 개수)
  // - 2: 2번째 행(헤더를 제외한 실제 데이터 시작줄)부터
  // - 1: 1번째 열(A열: fileId)부터 시작해서
  // - lastRow - 1: 실제 데이터가 들어있는 행의 개수만큼
  // - 2: 총 2개의 열(A열: fileId, B열: 파일명)을 가져옵니다.
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();

  // [키워드 검색 및 ID 추출]
  return data
    .filter(row => {
      // 자바스크립트 배열은 0부터 시작합니다.
      // row[0] = A열 (fileId)
      // row[1] = B열 (파일명)
      const fileName = row[1] || ''; // 혹시 파일명이 비어있을 경우를 대비해 기본값 '' 처리
      return fileName.toLowerCase().includes(keyword); // 파일명에 키워드가 포함되어 있는지 확인
    })
    .map(row => {
      // 필터링을 통과한 데이터에서 A열(fileId)만 뽑아서 배열로 만듭니다.
      const fileId = row[0];
      return fileId;
    });
}

// ── Drive fullText 검색 ──────────────────────────────────────────────────────
function driveFullTextSearch(keyword) {
  // Advanced Drive Service (Drive API v3) 필요
  // Apps Script 편집기 → 서비스 → Drive API v3 추가
  const q = `(name contains '${keyword}' or fullText contains '${keyword}') and trashed=false`;
  const opt = {
    q                    : q,
    fields               : 'nextPageToken, files(id)',
    pageSize             : 1000,
    supportsAllDrives    : true,
    includeItemsFromAllDrives: true,
  };

  const ids = [];
  try {
    let response = DRIVE_SERVICE.Files.list(opt);
    while (true) {
      (response.files || []).forEach(file => ids.push(file.id));
      if (!response.nextPageToken) break;
      opt.pageToken = response.nextPageToken;
      response = DRIVE_SERVICE.Files.list(opt);
    }
  } catch (err) {
    Logger.log('driveFullTextSearch error [' + keyword + ']: ' + err.message);
  }
  return ids;
}

// ── fileId 배열 → 메타데이터 조회 (FILE_INDEX_SHEET) ──────────────────────────────────
function lookupMetadata(fileIds) {
  const ss    = SpreadsheetApp.openById(INDEX_SHEET_ID);
  const sheet = ss.getSheetByName(FILE_INDEX_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();

  // Map 구성: fileId → {name, path, url}
  const map = {};
  data.forEach(row => {
    if (row[0]) map[row[0]] = { name: row[1], path: row[2], url: row[3] };
  });

  const results = [];
  fileIds.forEach(id => {
    if (map[id]) results.push(map[id]);
  });
  return results;
}

// ── 메타데이터 인덱스 재빌드 (매일 02:00 트리거) ────────────────────────────
function rebuildMetadataIndex() {
  const ss    = SpreadsheetApp.openById(INDEX_SHEET_ID);
  const sheet = ss.getSheetByName(FILE_INDEX_SHEET);

  // 헤더
  sheet.getRange(1, 1, 1, 5).setValues([['fileId', '파일명', '폴더경로', 'URL', '수정일']]);

  // 기존 데이터 행 클리어
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).clearContent();
  }

  const rows = getAllFilesRecursive(FOLDER_ID, '');
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 5).setValues(rows);
  }
  Logger.log('rebuildMetadataIndex: ' + rows.length + '개 파일 인덱싱 완료');
}

// ── 폴더 재귀 탐색 ──────────────────────────────────────────────────────────
function getAllFilesRecursive(folderId, pathPrefix) {
  const folder      = DriveApp.getFolderById(folderId);
  const currentPath = pathPrefix ? pathPrefix + '/' + folder.getName() : folder.getName();
  let   rows        = [];

  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    rows.push([
      f.getId(),
      f.getName(),
      currentPath,
      f.getUrl(),
      Utilities.formatDate(f.getLastUpdated(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    ]);
  }

  const subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    const sub = subfolders.next();
    rows = rows.concat(getAllFilesRecursive(sub.getId(), currentPath));
  }
  return rows;
}

// ── 캐시 워밍 ────────────────────────────────────────────────────────────────
function warmCache() {
  const ss    = SpreadsheetApp.openById(INDEX_SHEET_ID);
  const sheet = ss.getSheetByName(KEYWORD_LOG_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

  // 1순위: 검색횟수 내림차순, 2순위: 최근 검색일 내림차순 (동점 처리)
  data.sort((a, b) =>
    parseInt(b[1], 10) - parseInt(a[1], 10) ||
    new Date(b[2]) - new Date(a[2])
  );

  const topN  = data.slice(0, PRECACHE_TOP_N);
  const cache = CacheService.getScriptCache();

  topN.forEach(row => {
    const kw  = (row[0] || '').toLowerCase().trim();
    if (!kw) return;
    const key = 'kw_' + kw;
    if (cache.get(key) !== null) return; // 캐시 히트 → skip

    const ids = driveFullTextSearch(kw);
    cache.put(key, JSON.stringify(ids), CACHE_TTL);
    Utilities.sleep(200);
  });
  Logger.log('warmCache 완료');
}

// ── 만료 키워드 정리 (매일 03:00 트리거) ────────────────────────────────────
function purgeStaleKeywords() {
  const ss    = SpreadsheetApp.openById(INDEX_SHEET_ID);
  const sheet = ss.getSheetByName(KEYWORD_LOG_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30); // 30일 이상 미검색 키워드 삭제

  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  const kept = data.filter(row => row[0] && new Date(row[2]) >= cutoff);

  sheet.getRange(2, 1, lastRow - 1, 3).clearContent();
  if (kept.length > 0) {
    sheet.getRange(2, 1, kept.length, 3).setValues(kept);
  }
  Logger.log('purgeStaleKeywords: ' + (data.length - kept.length) + '개 삭제, ' + kept.length + '개 유지');
}

// ── 트리거 설치 (수동 1회 실행) ──────────────────────────────────────────────
function setupTriggers() {
  // 기존 트리거 전체 삭제 (중복 방지)
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('rebuildMetadataIndex').timeBased().atHour(2).nearMinute(0).everyDays(1).create();
  ScriptApp.newTrigger('warmCache').timeBased().atHour(2).nearMinute(30).everyDays(1).create();
  ScriptApp.newTrigger('warmCache').timeBased().atHour(7).nearMinute(30).everyDays(1).create();
  ScriptApp.newTrigger('warmCache').timeBased().atHour(12).nearMinute(30).everyDays(1).create();
  ScriptApp.newTrigger('warmCache').timeBased().atHour(17).nearMinute(30).everyDays(1).create();
  ScriptApp.newTrigger('purgeStaleKeywords').timeBased().atHour(3).nearMinute(0).everyDays(1).create();

  Logger.log('트리거 6개 설치 완료');
}

// ── 관리자 비밀번호 확인 후 인덱스 재빌드 실행 ───────────────────────────────────
function runAdminRebuild(clientHash) {
  // 서버에 저장된 평문 비밀번호를 SHA-256으로 해싱
  const serverHash = _computeSHA256(ADMIN_PASSWORD);

  // 클라이언트에서 넘어온 해시값과 비교
  if (clientHash !== serverHash) {
    throw new Error('비밀번호가 올바르지 않습니다.');
  }

  try {
    rebuildMetadataIndex(); // 기존에 작성된 함수 호출
    return "인덱스 갱신에 성공했습니다!";
  } catch (e) {
    throw new Error("갱신 중 오류 발생: " + e.message);
  }
}

// ── SHA-256 해시 생성을 위한 내부 헬퍼 함수 ─────────────────────────────────────
function _computeSHA256(str) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return digest.map(function(byte) {
    const v = (byte < 0) ? 256 + byte : byte;
    return ("0" + v.toString(16)).slice(-2);
  }).join("");
}

// ── Boolean 쿼리 파서 ────────────────────────────────────────────────────────

function tokenize(query) {
  // 괄호 앞뒤에 공백 삽입 후 분리
  const raw = query.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/);
  return raw.filter(s => s.length > 0).map(s => {
    const upper = s.toUpperCase();
    if (upper === 'AND')  return { type: 'AND',    value: 'AND' };
    if (upper === 'OR')   return { type: 'OR',     value: 'OR' };
    if (upper === 'NOT')  return { type: 'NOT',    value: 'NOT' };
    if (upper === '(')    return { type: 'LPAREN', value: '(' };
    if (upper === ')')    return { type: 'RPAREN', value: ')' };
    return { type: 'KEYWORD', value: s.toLowerCase() };
  });
}

function buildExpressionTree(tokens) {
  let pos = 0;

  function peek()    { return pos < tokens.length ? tokens[pos] : null; }
  function consume() { return tokens[pos++]; }

  function parseExpr() {
    let left = parseTerm();
    while (peek() && peek().type === 'OR') {
      consume();
      const right = parseTerm();
      left = { type: 'OR', left, right };
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (peek() && peek().type !== 'OR' && peek().type !== 'RPAREN') {
      if (peek().type === 'AND') consume(); // 명시적 AND 소비
      if (!peek() || peek().type === 'OR' || peek().type === 'RPAREN') break;
      const right = parseFactor();
      left = { type: 'AND', left, right };
    }
    return left;
  }

  function parseFactor() {
    if (peek() && peek().type === 'NOT') {
      consume();
      return { type: 'NOT', operand: parseFactor() };
    }
    return parseAtom();
  }

  function parseAtom() {
    const tok = peek();
    if (!tok) return { type: 'EMPTY' };

    if (tok.type === 'LPAREN') {
      consume();
      const node = parseExpr();
      if (peek() && peek().type === 'RPAREN') consume();
      return node;
    }
    if (tok.type === 'KEYWORD') {
      consume();
      return { type: 'KEYWORD', value: tok.value };
    }
    // 예상치 못한 토큰 (연산자만 있는 경우 등)
    consume();
    return { type: 'EMPTY' };
  }

  return parseExpr();
}

function evaluate(node) {
  if (!node || node.type === 'EMPTY') return new Set();

  if (node.type === 'KEYWORD') {
    return new Set(getFileIdsForKeyword(node.value));
  }
  if (node.type === 'AND') {
    return intersect(evaluate(node.left), evaluate(node.right));
  }
  if (node.type === 'OR') {
    return union(evaluate(node.left), evaluate(node.right));
  }
  if (node.type === 'NOT') {
    return difference(getAllFileIds(), evaluate(node.operand));
  }
  return new Set();
}

// ── 집합 연산 헬퍼 ───────────────────────────────────────────────────────────
function intersect(a, b) {
  return new Set([...a].filter(id => b.has(id)));
}

function union(a, b) {
  return new Set([...a, ...b]);
}

function difference(a, b) {
  return new Set([...a].filter(id => !b.has(id)));
}

function getAllFileIds() {
  const ss    = SpreadsheetApp.openById(INDEX_SHEET_ID);
  const sheet = ss.getSheetByName(FILE_INDEX_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();

  const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  return new Set(data.map(r => r[0]).filter(id => id !== ''));
}
