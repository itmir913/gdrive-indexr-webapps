// ── 상수 ────────────────────────────────────────────────────────────────────
const FOLDER_ID           = 'your_root_folder_id';
const INDEX_SHEET_ID      = 'your_spreadsheet_id';
const ADMIN_PASSWORD      = 'admin1234';   // 실제 사용할 비밀번호로 변경하세요. 편의를 위해 평문으로 작성해도 됩니다.

const FILE_INDEX_SHEET    = 'FileIndex';   // 파일 메타데이터 인덱스 시트 이름
const KEYWORD_LOG_SHEET   = 'KeywordLog';  // 키워드 빈도 로그 시트 이름
const CACHE_TTL           = 21600;         // 6시간 (Google 하드 리밋)
const PRECACHE_TOP_N      = 100;           // warmCache 사전 워밍 대상 상위 N개; 나머지는 첫 검색 시 온디맨드 캐싱
const DRIVE_SERVICE       = Drive;         // Apps Script 서비스 식별자 (편집기 → 서비스 → 식별자)

// ── 메타데이터 인덱스 재빌드 (매일 02:00 트리거 / 시간 초과 방지 / 이어하기 지원) ───
function rebuildMetadataIndex() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('[rebuildMetadataIndex] 다른 인스턴스 실행 중, 건너뜀');
    return 'skipped';
  }
  try {
    return _rebuildMetadataIndexImpl();
  } finally {
    lock.releaseLock();
  }
}

function _rebuildMetadataIndexImpl() {
  const MAX_EXECUTION_TIME = 4 * 60 * 1000; // 4분 (안전하게 설정)
  const startTime = Date.now();
  const props = PropertiesService.getScriptProperties();

  const ss = SpreadsheetApp.openById(INDEX_SHEET_ID);
  const sheet = ss.getSheetByName(FILE_INDEX_SHEET);
  if (!sheet) {
    Logger.log('[rebuildMetadataIndex] FileIndex 시트를 찾을 수 없습니다.');
    return 'error';
  }

  // 진행 상태(대기열) 불러오기
  let queueStr = props.getProperty('FOLDER_QUEUE');
  const parsedQueue = queueStr ? JSON.parse(queueStr) : null;
  const isStaleQueue = parsedQueue && (Date.now() - (parsedQueue.ts || 0)) > 24 * 60 * 60 * 1000;
  let folderQueue = (!parsedQueue || isStaleQueue) ? null : parsedQueue.queue;

  // 처음 실행되는 경우 (대기열이 없을 때)
  if (!folderQueue) {
    folderQueue = [{ id: FOLDER_ID, path: '' }];

    // 기존 데이터 초기화 및 헤더 작성
    if (sheet.getLastRow() >= 2) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).clearContent();
    }
    sheet.getRange(1, 1, 1, 5).setValues([['fileId', '파일명', '폴더경로', 'URL', '수정일']]);

    deleteTempTriggers();
  }

  let rows = [];

  while (folderQueue.length > 0) {
    // 1. 실행 시간이 4분을 초과했는지 확인
    if (Date.now() - startTime > MAX_EXECUTION_TIME) {
      props.setProperty('FOLDER_QUEUE', JSON.stringify({ queue: folderQueue, ts: Date.now() })); // 남은 폴더 저장
      if (rows.length > 0) {
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
      }
      // 1분 뒤 이어하기 트리거 생성
      ScriptApp.newTrigger('continueIndexing').timeBased().after(60 * 1000).create();
      Logger.log(`[시간 초과 방지] 남은 폴더: ${folderQueue.length}개. 1분 뒤 이어하기 실행.`);
      return 'in_progress';
    }

    // 2. 폴더 탐색
    const current = folderQueue.shift();
    try {
      const folder = DriveApp.getFolderById(current.id);
      const currentPath = current.path ? current.path + '/' + folder.getName() : folder.getName();
      const files = folder.getFiles();

      while (files.hasNext()) {
        const f = files.next();
        rows.push([
          f.getId(), f.getName(), currentPath, f.getUrl(),
          Utilities.formatDate(f.getLastUpdated(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
        ]);

        if (rows.length >= 500) {
          sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
          rows = [];
        }
      }

      const subfolders = folder.getFolders();
      while (subfolders.hasNext()) {
        folderQueue.push({ id: subfolders.next().getId(), path: currentPath });
      }
    } catch (e) {
      Logger.log(`폴더 접근 오류 [${current.id}]: ${e.message}`);
    }
  }

  // 3. 탐색 완료
  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  }
  props.deleteProperty('FOLDER_QUEUE');
  deleteTempTriggers();

  // 인덱스 갱신 완료 → 메타데이터 캐시 및 키워드 캐시 무효화
  const cache = CacheService.getScriptCache();
  cache.remove('meta_chunk_count');
  try {
    const kwSheet = ss.getSheetByName(KEYWORD_LOG_SHEET);
    const kwLastRow = kwSheet.getLastRow();
    if (kwLastRow >= 2) {
      const kwData = kwSheet.getRange(2, 1, kwLastRow - 1, 1).getValues();
      const nKeys = kwData
        .map(r => String(r[0] ?? '').toLowerCase().trim())
        .filter(kw => kw)
        .map(kw => 'kw_' + kw + '_n');

      if (nKeys.length > 0) {
        const nValues = _batchGetAll(cache, nKeys); // 청크 수 일괄 조회 (500개 배치)
        const allKeys = [];
        nKeys.forEach(nKey => {
          allKeys.push(nKey);
          const count = parseInt(nValues[nKey], 10);
          if (count > 0) {
            const base = nKey.slice(0, -2); // 'kw_<keyword>' 추출 (_n 제거)
            for (let i = 0; i < count; i++) allKeys.push(base + '_' + i);
          }
        });
        _batchRemoveAll(cache, allKeys); // 500개 배치
      }
    }
  } catch (e) {
    Logger.log('키워드 캐시 무효화 오류: ' + e.message);
  }

  Logger.log('🎉 인덱싱 완료!');
  return 'done';
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

// ── 진입점 ───────────────────────────────────────────────────────────────────
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('대학진학자료 통합검색기');
}

// ── 검색 메인 (google.script.run 호출점) ────────────────────────────────────
function doSearch(query) {
  try {
    query = (query || '').trim();
    if (!query) return [];

    const tokens = tokenize(query);

    // 로깅용 키워드 추출 (연산자·괄호 제외, 중복 제거)
    const keywords = [...new Set(
      tokens.filter(t => t.type === 'KEYWORD').map(t => t.value)
    )];
    try { logKeywords(keywords); } catch (e) { Logger.log('logKeywords error: ' + e.message); }

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
    if (!sheet) return;
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

    // 헤더 보장
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['키워드', '검색횟수', '마지막검색일']);
    }

    keywords.forEach(kw => {
      const lastRow = sheet.getLastRow();
      // 헤더(1행) 제외하고 키워드 열에서만 정확히 일치하는 셀 탐색
      const found = lastRow >= 2
        ? sheet.getRange(2, 1, lastRow - 1, 1).createTextFinder(kw).matchEntireCell(true).findNext()
        : null;

      if (found) {
        const r = found.getRow();
        const count = (parseInt(sheet.getRange(r, 2).getValue(), 10) || 0) + 1;
        sheet.getRange(r, 2, 1, 2).setValues([[count, today]]);
      } else {
        sheet.appendRow([kw, 1, today]);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

// ── CacheService 배치 헬퍼 (GAS getAll/removeAll 500개 한도 우회) ───────────
function _batchGetAll(cache, keys) {
  const BATCH = 500;
  const result = {};
  for (let i = 0; i < keys.length; i += BATCH) {
    Object.assign(result, cache.getAll(keys.slice(i, i + BATCH)));
  }
  return result;
}

function _batchRemoveAll(cache, keys) {
  const BATCH = 500;
  for (let i = 0; i < keys.length; i += BATCH) {
    cache.removeAll(keys.slice(i, i + BATCH));
  }
}

// ── 청크 캐시 헬퍼 (100KB 제한 우회) ────────────────────────────────────────
function _putChunkedCache(cache, baseKey, data, ttl) {
  const json = JSON.stringify(data);
  const size = 30000; // 한글 3바이트 × 30000 = 90KB < 100KB 제한
  const count = Math.ceil(json.length / size) || 1;
  const obj = { [baseKey + '_n']: String(count) };
  for (let i = 0; i < count; i++) {
    obj[baseKey + '_' + i] = json.substring(i * size, (i + 1) * size);
  }
  cache.putAll(obj, ttl);
}

function _getChunkedCache(cache, baseKey) {
  const countStr = cache.get(baseKey + '_n');
  if (!countStr) return null;
  const count = parseInt(countStr, 10);
  const keys = Array.from({ length: count }, (_, i) => baseKey + '_' + i);
  const chunks = cache.getAll(keys);
  let json = '';
  for (let i = 0; i < count; i++) {
    if (!chunks[baseKey + '_' + i]) return null;
    json += chunks[baseKey + '_' + i];
  }
  try { return JSON.parse(json); } catch (e) { return null; }
}

// ── 키워드 → fileId 배열 (캐시 우선) ────────────────────────────────────────
function getFileIdsForKeyword(keyword) {
  keyword = keyword.toLowerCase().trim();
  const baseKey = 'kw_' + keyword;
  const cache = CacheService.getScriptCache();

  const cached = _getChunkedCache(cache, baseKey);
  if (cached !== null) return cached;

  const driveIds = driveFullTextSearch(keyword);      // 1. 드라이브 전체 텍스트 검색 (내용 중심)
  const sheetIds = getNameMatchesFromSheet(keyword);  // 2. 스프레드시트 인덱스에서 파일명 검색 (파일명 중심)
  const combinedIds = [...new Set([...driveIds, ...sheetIds])];  // 3. 두 결과 합치기 (중복 제거)

  _putChunkedCache(cache, baseKey, combinedIds, CACHE_TTL);
  return combinedIds;
}

// ── 시트 인덱스에서 파일명으로 ID를 찾아주는 헬퍼 함수 ──────────────────
function getNameMatchesFromSheet(keyword) {
  const map = getCachedMetadataMap();
  return Object.entries(map)
    .filter(([, meta]) => (meta.name || '').toLowerCase().includes(keyword))
    .map(([id]) => id);
}

// ── Drive fullText 검색 ──────────────────────────────────────────────────────
function driveFullTextSearch(keyword) {
  // Advanced Drive Service (Drive API v3) 필요
  // Apps Script 편집기 → 서비스 → Drive API v3 추가
  const escaped = keyword.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed=false`;
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
// ── fileId 배열 → 메타데이터 조회 (메모리 캐싱 적용) ──────────────────────────────────
function lookupMetadata(fileIds) {
  if (!fileIds || fileIds.length === 0) return [];

  // 캐시(또는 시트)에서 전체 파일 정보 Map을 가져옵니다.
  const map = getCachedMetadataMap();
  const results = [];

  fileIds.forEach(id => {
    if (map[id]) results.push(map[id]);
  });
  return results;
}

// ── 메타데이터 전체 캐싱 헬퍼 (100KB 제한 우회용 청크 분할) ──────────────────
function getCachedMetadataMap() {
  const cache = CacheService.getScriptCache();
  const chunkCountStr = cache.get('meta_chunk_count');

  // 1. 캐시 히트: 쪼개진 청크들을 한 번에 가져와서 조립
  if (chunkCountStr !== null) {
    const chunkCount = parseInt(chunkCountStr, 10);
    const keys = [];
    for (let i = 0; i < chunkCount; i++) {
      keys.push('meta_chunk_' + i);
    }

    const chunksObj = cache.getAll(keys); // API 호출 1번으로 최적화
    let jsonStr = '';
    let isCacheValid = true;

    for (let i = 0; i < chunkCount; i++) {
      if (!chunksObj['meta_chunk_' + i]) {
        isCacheValid = false; // 중간에 청크가 하나라도 유실되었으면 무효화
        break;
      }
      jsonStr += chunksObj['meta_chunk_' + i];
    }

    if (isCacheValid) {
      try {
        return JSON.parse(jsonStr); // 메모리에 룩업 테이블(Map) 즉시 복원
      } catch (e) {
        // 파싱 실패 시 아래 시트 읽기 로직으로 폴백(Fallback)
      }
    }
  }

  // 2. 캐시 미스: 스프레드시트에서 직접 읽어오기
  const ss = SpreadsheetApp.openById(INDEX_SHEET_ID);
  const sheet = ss.getSheetByName(FILE_INDEX_SHEET);
  if (!sheet) return {};
  const lastRow = sheet.getLastRow();
  const map = {};

  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    data.forEach(row => {
      if (row[0]) map[row[0]] = { name: row[1], path: row[2], url: row[3] };
    });
  }

  // 3. 캐시에 저장 (GAS 100KB 제한을 피하기 위해 30KB씩 분할: 한글 3바이트 × 30000 = 90KB)
  const jsonStr = JSON.stringify(map);
  const chunkSize = 30000; // 한글 3바이트 × 30000 = 90KB < 100KB 제한
  const chunks = Math.ceil(jsonStr.length / chunkSize);

  const cacheObj = { 'meta_chunk_count': chunks.toString() };
  for (let i = 0; i < chunks; i++) {
    cacheObj['meta_chunk_' + i] = jsonStr.substring(i * chunkSize, (i + 1) * chunkSize);
  }

  // 쪼개진 데이터를 캐시에 한 번에 저장 (최적화)
  cache.putAll(cacheObj, CACHE_TTL);

  return map;
}

// ── 이어하기 헬퍼 함수 ──────────────────────────────────────────────────────
function continueIndexing() {
  rebuildMetadataIndex();
}

function deleteTempTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'continueIndexing') ScriptApp.deleteTrigger(t);
  });
}

// ── 캐시 워밍 ────────────────────────────────────────────────────────────────
function warmCache() {
  const MAX_WARM_TIME = 4 * 60 * 1000; // 4분
  const startTime = Date.now();

  const ss    = SpreadsheetApp.openById(INDEX_SHEET_ID);
  const sheet = ss.getSheetByName(KEYWORD_LOG_SHEET);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

  // 1순위: 검색횟수 내림차순, 2순위: 최근 검색일 내림차순 (동점 처리)
  data.sort((a, b) =>
    (parseInt(b[1], 10) || 0) - (parseInt(a[1], 10) || 0) ||
    new Date(b[2]) - new Date(a[2])
  );

  const topN  = data.slice(0, PRECACHE_TOP_N);
  const cache = CacheService.getScriptCache();
  let warmed = 0;

  for (const row of topN) {
    if (Date.now() - startTime > MAX_WARM_TIME) break; // 시간 초과 시 즉시 종료
    const kw = String(row[0] ?? '').toLowerCase().trim();
    if (!kw) continue;
    const baseKey = 'kw_' + kw;
    if (_getChunkedCache(cache, baseKey) !== null) continue; // 캐시 히트 → skip

    const driveIds = driveFullTextSearch(kw);
    const sheetIds = getNameMatchesFromSheet(kw);
    const ids = [...new Set([...driveIds, ...sheetIds])];
    _putChunkedCache(cache, baseKey, ids, CACHE_TTL);
    warmed++;
    Utilities.sleep(200);
  }
  Logger.log(`warmCache 완료 (${warmed}개 워밍)`);
}

// ── 만료 키워드 정리 (매일 03:00 트리거) ────────────────────────────────────
function purgeStaleKeywords() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return;
  }
  try {
    const ss    = SpreadsheetApp.openById(INDEX_SHEET_ID);
    const sheet = ss.getSheetByName(KEYWORD_LOG_SHEET);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3); // 3일 이상 미검색 키워드 삭제

    const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    const kept = data.filter(row => row[0] && new Date(row[2]) >= cutoff);

    sheet.getRange(2, 1, lastRow - 1, 3).clearContent();
    if (kept.length > 0) {
      sheet.getRange(2, 1, kept.length, 3).setValues(kept);
    }
    Logger.log('purgeStaleKeywords: ' + (data.length - kept.length) + '개 삭제, ' + kept.length + '개 유지');
  } finally {
    lock.releaseLock();
  }
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
    const status = rebuildMetadataIndex();
    if (status === 'done')      return '인덱스 갱신에 성공했습니다!';
    if (status === 'skipped')   return '다른 인덱싱 작업이 이미 실행 중입니다. 잠시 후 다시 시도하세요.';
    if (status === 'error')     return 'FileIndex 시트를 찾을 수 없습니다. 스프레드시트 설정을 확인하세요.';
    return '인덱스 갱신 진행 중입니다. 파일 수가 많아 백그라운드에서 이어하기가 실행됩니다 (약 1분 후 자동 완료).';
  } catch (e) {
    throw new Error('갱신 중 오류 발생: ' + e.message);
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
    const leftSet = evaluate(node.left);
    // 단축 평가: 왼쪽 결과가 없으면 오른쪽은 검색(API 호출)조차 하지 않음!
    if (leftSet.size === 0) return new Set();
    return intersect(leftSet, evaluate(node.right));
  }
  if (node.type === 'OR') {
    return union(evaluate(node.left), evaluate(node.right));
  }
  if (node.type === 'NOT') {
    const allIds = getAllFileIds();
    const excludeSet = evaluate(node.operand);
    return difference(allIds, excludeSet);
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
  return new Set(Object.keys(getCachedMetadataMap()));
}
