// ── 상수 ────────────────────────────────────────────────────────────────────
const INDEX_SHEET_ID      = 'your_spreadsheet_id';  // 스프레드시트 ID
const FOLDER_ID           = 'your_root_folder_id';  // 구글 드라이브 폴더 ID
const ADMIN_PASSWORD      = 'admin1234';   // 인덱스 갱신을 위한 관리자 비밀번호
                                           // Code.gs는 배포 후에도 소스가 공개되지 않으므로 평문으로 작성

const FILE_INDEX_SHEET    = 'FileIndex';   // 파일 메타데이터 인덱스 시트 이름
const KEYWORD_LOG_SHEET   = 'KeywordLog';  // 키워드 빈도 로그 시트 이름
const CACHE_TTL           = 21600;         // 6시간 (Google 하드 리밋)
const CACHE_CHUNK_SIZE    = 30000;         // 청크 크기 (한글 3바이트 × 30000 = 90KB < 100KB 제한)
const PRECACHE_TOP_N      = 100;           // warmCache 사전 워밍 대상 상위 N개; 나머지는 첫 검색 시 온디맨드 캐싱
const REBUILD_FLAG_KEY    = 'REBUILD_STARTED_AT';  // 재빌드 중복 실행 방지 플래그 (ScriptProperties)
const REBUILD_FLAG_LOCK_MS = 10000;        // 플래그 test-and-set 동안만 잡는 짧은 잠금
const REBUILD_STALE_MS    = 10 * 60 * 1000; // 이 시간이 지난 플래그는 비정상 종료로 보고 무시
const DRIVE_SERVICE       = Drive;         // Apps Script 서비스 식별자 (편집기 → 서비스 → 식별자)

// ── 메타데이터 인덱스 재빌드 (매일 02:00 트리거 / 시간 초과 방지 / 이어하기 지원) ───
function rebuildMetadataIndex() {
  // [fix-13.7][fix-13.8] 예전에는 스크립트 락을 재빌드 4분 내내 쥐고 있었다. 그 결과
  //   - logKeywords(waitLock 5000)가 그 창에서 반드시 실패해 KeywordLog에 기록되지 않았고,
  //     그 키워드의 캐시는 완료 시 무효화 목록(KeywordLog 기반)에서 빠져 6시간 살아남았다.
  //   - continueIndexing이 다른 락 보유자와 부딪히면 tryLock(0)에 막혀 그대로 끝났다.
  //   락은 플래그 test-and-set 동안만 짧게 잡고, 상호배제는 플래그가 담당한다.
  const props = PropertiesService.getScriptProperties();
  const lock  = LockService.getScriptLock();
  if (!lock.tryLock(REBUILD_FLAG_LOCK_MS)) {
    Logger.log('[rebuildMetadataIndex] 플래그 확인용 잠금 실패, 건너뜀');
    return 'skipped';
  }
  try {
    const startedAt = parseInt(props.getProperty(REBUILD_FLAG_KEY), 10) || 0;
    if (startedAt && (Date.now() - startedAt) < REBUILD_STALE_MS) {
      Logger.log('[rebuildMetadataIndex] 다른 인스턴스 실행 중, 건너뜀');
      return 'skipped';
    }
    props.setProperty(REBUILD_FLAG_KEY, String(Date.now()));
  } finally {
    lock.releaseLock();   // 긴 탐색 전에 반드시 해제
  }

  try {
    return _rebuildMetadataIndexImpl();
  } finally {
    PropertiesService.getScriptProperties().deleteProperty(REBUILD_FLAG_KEY);
  }
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
    .setTitle('대입진학자료 통합검색기');
}

// ── FileIndex 행 추가 ───────────────────────────────────────────────────────
// [fix-13.5] setValues는 셀 입력처럼 파싱되므로 "2027"은 숫자로, "2026.03.01"은
//            날짜로 저장된다. 쓰기 직전 그 범위를 일반 텍스트(@)로 고정해
//            파일명·경로가 원본 문자열 그대로 보존되게 한다.
//            (시트 전체가 아니라 실제 쓰는 범위에 걸어야 자동 확장된 행까지 덮는다)
function _appendIndexRows(sheet, rows) {
  if (!rows || rows.length === 0) return;
  const range = sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5);
  range.setNumberFormat('@');
  range.setValues(rows);
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
        _appendIndexRows(sheet, rows);
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
          _appendIndexRows(sheet, rows);
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
    _appendIndexRows(sheet, rows);
  }
  props.deleteProperty('FOLDER_QUEUE');
  deleteTempTriggers();

  // 인덱스 갱신 완료 → 메타데이터 캐시 및 키워드 캐시 무효화
  const cache = CacheService.getScriptCache();
  cache.remove('meta_chunk_count');
  try {
    const kwSheet = ss.getSheetByName(KEYWORD_LOG_SHEET);
    if (!kwSheet) {
      Logger.log('키워드 캐시 무효화 생략: KeywordLog 시트를 찾을 수 없음');
    } else {
      const kwLastRow = kwSheet.getLastRow();
      if (kwLastRow >= 2) {
        const kwData = kwSheet.getRange(2, 1, kwLastRow - 1, 1).getValues();
        const nKeys = kwData
          .map(r => _normalizeKeyword(r[0]))   // 캐시 키와 동일 정규화
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
    }
  } catch (e) {
    Logger.log('키워드 캐시 무효화 오류: ' + e.message);
  }

  Logger.log('🎉 인덱싱 완료!');
  return 'done';
}

// ── 검색 메인 (google.script.run 호출점) ────────────────────────────────────
function doSearch(query) {
  query = (query || '').trim();
  if (!query) return [];

  const tokens = tokenize(query);

  var bparser = new BooleanParser(tokens);
  var tree    = bparser.parse();
  // [fix-13.6] 소비되지 않은 토큰이 남으면 잘못된 검색식이다. 빈 배열로 돌려주면
  //            프론트가 "검색 결과가 없습니다"로 표시해 교사가 오타를 눈치채지 못한다.
  if (bparser.pos < bparser.tokens.length) {
    return { error: '잘못된 검색식입니다. 괄호를 확인하세요.' };
  }

  // [fix-13.B7] AST 기준으로 키워드를 추출한다. 토큰 기준으로 뽑으면 파서가 EMPTY로
  //   소비한 토큰까지 세어 Docker(`extractKeywords`)와 갈라진다.
  const keywords = [...new Set(
    [..._extractKeywords(tree)]
      .map(function(t) { return _normalizeKeyword(t); })
      .filter(function(t) { return t; })
  )];

  // [fix-13.B7] 키워드가 없는 질의(`NOT` 단독 등) 차단. 이 가드가 없으면
  //   `NOT` → NOT(EMPTY) → difference(전체, 공집합) = 전체 파일 목록이 반환된다.
  //   11차의 F16이 Docker에만 적용돼 있었고, 프론트 가드만으로는 서버가 보호되지 않는다.
  if (keywords.length === 0) return [];

  // [fix-13.13] 로깅은 검색식 검증을 통과한 뒤에만. 이전에는 오타 질의의 키워드가
  //             KeywordLog에 들어가 warmCache가 그것으로 Drive를 검색했다.
  try { logKeywords(keywords); } catch (e) { Logger.log('logKeywords error: ' + e.message); }

  const allIds    = getAllFileIds();
  const resultSet = evaluate(tree, allIds);
  if (resultSet.size === 0) return [];

  return lookupMetadata([...resultSet]);
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
        // [fix-13.5] "3-1" 같은 키워드가 날짜로 저장되지 않도록 쓰기 전 A열을 텍스트로 고정
        const newRow = sheet.getLastRow() + 1;
        sheet.getRange(newRow, 1).setNumberFormat('@');
        sheet.getRange(newRow, 1, 1, 3).setValues([[kw, 1, today]]);
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

function _batchPutAll(cache, obj, ttl) {
  const BATCH = 500;
  const entries = Object.entries(obj);
  for (let i = 0; i < entries.length; i += BATCH) {
    cache.putAll(Object.fromEntries(entries.slice(i, i + BATCH)), ttl);
  }
}

// ── 청크 캐시 헬퍼 (100KB 제한 우회) ────────────────────────────────────────
function _putChunkedCache(cache, baseKey, data, ttl) {
  const json = JSON.stringify(data);
  const count = Math.ceil(json.length / CACHE_CHUNK_SIZE) || 1;
  const obj = { [baseKey + '_n']: String(count) };
  for (let i = 0; i < count; i++) {
    obj[baseKey + '_' + i] = json.substring(i * CACHE_CHUNK_SIZE, (i + 1) * CACHE_CHUNK_SIZE);
  }
  _batchPutAll(cache, obj, ttl);
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

// ── 검색 키 정규화 ──────────────────────────────────────────────────────────
// [fix-13.5]  시트는 "2027", "3-1" 같은 값을 Number/Date로 돌려주므로 String()으로 감싼다.
// [fix-13.11] macOS 업로드 파일명은 한글이 NFD라 NFC 검색어와 코드 포인트가 다르다.
function _normKey(s) {
  return String(s == null ? '' : s).normalize('NFC').toLowerCase();
}

// 캐시 키·KeywordLog·검색이 모두 같은 형태를 쓰도록 단일 함수로 관리
function _normalizeKeyword(kw) {
  return _normKey(kw).replace(/['"]/g, '').trim();
}

// [fix-13.B7] AST에서 키워드 추출 — Docker의 search-pipeline.js `extractKeywords`와 동일
function _extractKeywords(node) {
  if (!node || node.type === 'EMPTY') return new Set();
  if (node.type === 'KEYWORD') return new Set([node.value]);
  if (node.type === 'NOT') return _extractKeywords(node.operand);
  return new Set([..._extractKeywords(node.left), ..._extractKeywords(node.right)]);
}

// [fix-13.2] 모든 폴더경로는 루트 폴더 이름으로 시작하므로 그대로 매칭하면 루트 이름의
//            부분 문자열이 전 파일에 걸린다. 첫 세그먼트(루트)를 떼고 하위 경로만 남긴다.
function _toSearchPath(path) {
  const s = String(path == null ? '' : path);
  const i = s.indexOf('/');
  return i === -1 ? '' : s.slice(i + 1);
}

// ── 키워드 → fileId 배열 (캐시 우선) ────────────────────────────────────────
function getFileIdsForKeyword(keyword) {
  keyword = _normalizeKeyword(keyword);
  // [fix-13.10] 따옴표만으로 이뤄진 질의(`""`)는 여기서 빈 문자열이 되고,
  //             그대로 두면 includes('')가 전 파일에 걸려 전체 목록이 노출된다.
  if (!keyword) return [];
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
  if (!keyword) return [];   // [fix-13.10] 빈 키워드는 includes('')로 전건 매칭된다
  const map = getCachedMetadataMap();
  // [fix-13.2]  파일명 + 하위 폴더 경로(루트 폴더명 제외)를 매칭 — Docker판과 동일 기준
  // [fix-13.5]  meta.name이 Number/Date일 수 있어 _normKey가 String()으로 감싼다
  // [fix-13.11] 색인 측과 질의 측 모두 NFC로 정규화
  return Object.entries(map)
    .filter(([, meta]) =>
      _normKey(meta.name).includes(keyword) ||
      _normKey(_toSearchPath(meta.path)).includes(keyword))
    .map(([id]) => id);
}

// ── Drive fullText 검색 ──────────────────────────────────────────────────────
function driveFullTextSearch(keyword) {
  // Advanced Drive Service (Drive API v3) 필요
  // Apps Script 편집기 → 서비스 → Drive API v3 추가
  // [fix-B5] 큰따옴표도 이스케이프 추가 (이전: `"` 미처리로 Drive API 쿼리 malformed)
  const escaped = keyword.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
  const q = `fullText contains '"${escaped}"' and trashed=false`;
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

    const chunksObj = _batchGetAll(cache, keys);
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
      // [fix-13.5] 시트 서식이 무너진 기존 데이터를 대비한 방어.
      //            "2027"·"2026.03.01"·"TRUE" 같은 값은 Number/Date/Boolean으로 돌아오며,
      //            여기서 문자열로 고정하지 않으면 하류의 toLowerCase()가 TypeError를 던진다.
      if (row[0]) map[String(row[0])] = {
        name: String(row[1] == null ? '' : row[1]),
        path: String(row[2] == null ? '' : row[2]),
        url : String(row[3] == null ? '' : row[3])
      };
    });
  }

  // 3. 캐시에 저장 (GAS 100KB 제한을 피하기 위해 30KB씩 분할: 한글 3바이트 × 30000 = 90KB)
  const jsonStr = JSON.stringify(map);
  const chunks = Math.ceil(jsonStr.length / CACHE_CHUNK_SIZE);

  const cacheObj = { 'meta_chunk_count': chunks.toString() };
  for (let i = 0; i < chunks; i++) {
    cacheObj['meta_chunk_' + i] = jsonStr.substring(i * CACHE_CHUNK_SIZE, (i + 1) * CACHE_CHUNK_SIZE);
  }

  // 쪼개진 데이터를 캐시에 저장 (500개 배치)
  _batchPutAll(cache, cacheObj, CACHE_TTL);

  return map;
}

// ── 이어하기 헬퍼 함수 ──────────────────────────────────────────────────────
function continueIndexing() {
  const props = PropertiesService.getScriptProperties();

  // [fix-13.B3] 이어하기 트리거는 '이어하기'만 한다. 큐가 없으면 이미 끝난 것이므로
  //   아무것도 하지 않는다. 이 가드가 없으면, 아래 재예약과 다른 체인의 완료 처리가
  //   겹쳐 남은 고아 트리거가 rebuildMetadataIndex를 부르고, 큐가 없으니 '처음 실행'으로
  //   판정해 수업 시간에 시트를 비우고 전체 재색인을 시작한다.
  if (!props.getProperty('FOLDER_QUEUE')) {
    deleteTempTriggers();
    Logger.log('[continueIndexing] 남은 큐 없음 — 종료');
    return;
  }

  const result = rebuildMetadataIndex();

  // [fix-13.8] 건너뛴 경우 재예약이 없으면 큐가 남은 채 다음 02:00까지 방치된다.
  //            큐가 아직 남아 있을 때만 다시 예약하고, 직전 트리거를 지워 1개로 유지한다.
  if (result === 'skipped' && props.getProperty('FOLDER_QUEUE')) {
    deleteTempTriggers();
    ScriptApp.newTrigger('continueIndexing').timeBased().after(60 * 1000).create();
    Logger.log('[continueIndexing] 건너뜀 — 큐가 남아 1분 뒤 재시도 예약');
  }
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
    const kw = _normalizeKeyword(row[0]);   // 캐시 키와 동일 정규화
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
    const kept = data.filter(row => {
      if (!row[0]) return false;
      const d = new Date(row[2]);
      if (isNaN(d.getTime())) return true;  // 날짜 파싱 불가 → 보존
      return d >= cutoff;
    });

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

/**
 * 쿼리 문자열을 토큰 문자열 배열로 변환한다.
 * 연산자/괄호: "AND", "OR", "NOT", "(", ")"
 * 그 외 (공백 포함 가능): 키워드 (소문자화)
 *
 * 예) '서울 대학교  and  (면접 or 실기)'
 *   → ['서울 대학교', 'AND', '(', '면접', 'OR', '실기', ')']
 */
function tokenize(query) {
  // Step 1: 연속 공백 정규화
  query = query.replace(/\s{2,}/g, ' ').trim();
  if (!query) return [];

  // Step 2: 연산자·괄호 앞뒤에 구분자 삽입 후 분리
  query = query.replace(/\s*\b(and|or|not)\b\s*/gi, '|||$1|||');
  query = query.replace(/\s*([()])\s*/g, '|||$1|||');

  // Step 3: 분리 → 공백 제거 → 빈 문자열 제거
  var parts = query.split('|||');
  var tokens = [];
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i].trim();
    if (t.length === 0) continue;

    // Step 4: 연산자 대문자 정규화, 키워드 소문자화
    var upper = t.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
      tokens.push(upper);
    } else if (t === '(' || t === ')') {
      tokens.push(t);
    } else {
      tokens.push(t.toLowerCase());
    }
  }
  return tokens;
}

/**
 * 토큰 배열을 받아 AST를 생성하는 Recursive Descent Parser.
 * 우선순위: NOT > AND > OR (높을수록 먼저 결합)
 *
 * 사용법: new BooleanParser(tokens).parse()
 */
function BooleanParser(tokens) {
  this.tokens = tokens;
  this.pos = 0;
}

BooleanParser.prototype.peek = function() {
  return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
};

BooleanParser.prototype.consume = function() {
  return this.tokens[this.pos++];
};

/** 진입점: OR 레벨부터 파싱 */
BooleanParser.prototype.parse = function() {
  var node = this.parseOr();
  return node || { type: 'EMPTY' };
};

/** OR (최저 우선순위) */
BooleanParser.prototype.parseOr = function() {
  var left = this.parseAnd();
  while (this.peek() === 'OR') {
    this.consume();
    var right = this.parseAnd();
    left = { type: 'OR', left: left, right: right };
  }
  return left;
};

/** AND (명시적 AND 토큰 또는 NOT이 이항처럼 쓰인 경우 묵시적 AND 처리) */
BooleanParser.prototype.parseAnd = function() {
  var left = this.parseNot();
  for (;;) {
    var t = this.peek();
    if (t === 'AND') {
      this.consume(); // 명시적 AND
    } else if (t === 'NOT') {
      // 묵시적 AND: "X NOT Y" → AND(X, NOT Y)
    } else {
      break;
    }
    var right = this.parseNot();
    left = { type: 'AND', left: left, right: right };
  }
  return left;
};

/** NOT (단항, 우결합) */
BooleanParser.prototype.parseNot = function() {
  if (this.peek() === 'NOT') {
    this.consume();
    return { type: 'NOT', operand: this.parseNot() };
  }
  return this.parsePrimary();
};

/** 괄호 그룹 또는 단일 키워드 */
BooleanParser.prototype.parsePrimary = function() {
  var tok = this.peek();
  if (tok === null) return { type: 'EMPTY' };

  if (tok === '(') {
    this.consume();
    var node = this.parseOr();
    // 닫는 괄호가 있으면 소비, 없으면 자동으로 닫힌 것으로 간주
    if (this.peek() === ')') this.consume();
    return node;
  }

  // 연산자가 단독으로 나타나는 경우 (잘못된 입력): EMPTY 반환
  if (tok === 'AND' || tok === 'OR' || tok === 'NOT') {
    this.consume();
    return { type: 'EMPTY' };
  }
  if (tok === ')') {
    return { type: 'EMPTY' };
  }

  // 일반 키워드
  this.consume();
  return { type: 'KEYWORD', value: tok };
};

function evaluate(node, allIds) {
  if (!node || node.type === 'EMPTY') return new Set();

  if (node.type === 'KEYWORD') {
    return new Set(getFileIdsForKeyword(node.value));
  }
  if (node.type === 'AND') {
    var leftSet = evaluate(node.left, allIds);
    // 단축 평가: 왼쪽이 비면 오른쪽 API 호출 생략
    if (leftSet.size === 0) return new Set();
    return intersect(leftSet, evaluate(node.right, allIds));
  }
  if (node.type === 'OR') {
    return union(evaluate(node.left, allIds), evaluate(node.right, allIds));
  }
  if (node.type === 'NOT') {
    if (!allIds) allIds = getAllFileIds();
    var excludeSet = evaluate(node.operand, allIds);
    return difference(allIds, excludeSet);
  }
  return new Set();
}

// ── 집합 연산 헬퍼 ───────────────────────────────────────────────────────────
function intersect(a, b) {
  var result = new Set();
  a.forEach(function(id) { if (b.has(id)) result.add(id); });
  return result;
}

function union(a, b) {
  var result = new Set();
  a.forEach(function(id) { result.add(id); });
  b.forEach(function(id) { result.add(id); });
  return result;
}

function difference(a, b) {
  var result = new Set();
  a.forEach(function(id) { if (!b.has(id)) result.add(id); });
  return result;
}

function getAllFileIds() {
  return new Set(Object.keys(getCachedMetadataMap()));
}

// ── 테스트 스위트 (Apps Script 에디터에서 직접 실행) ─────────────────────────
function testBooleanParser() {
  var pass = 0;
  var fail = 0;

  function astToString(node) {
    if (!node || node.type === 'EMPTY') return 'EMPTY';
    if (node.type === 'KEYWORD') return node.value;
    if (node.type === 'NOT') return '(NOT ' + astToString(node.operand) + ')';
    return '(' + astToString(node.left) + ' ' + node.type + ' ' + astToString(node.right) + ')';
  }

  function check(label, input, expected) {
    var tokens = tokenize(input);
    var ast = new BooleanParser(tokens).parse();
    var got = astToString(ast);
    if (got === expected) {
      Logger.log('PASS: ' + label);
      pass++;
    } else {
      Logger.log('FAIL: ' + label + '\n  input:    ' + input + '\n  expected: ' + expected + '\n  got:      ' + got);
      fail++;
    }
  }

  // 기본 케이스
  check('단일 키워드',          'A',                    'a');
  check('AND 기본',             'A AND B',              '(a AND b)');
  check('OR 기본',              'A OR B',               '(a OR b)');
  check('NOT 기본',             'NOT A',                '(NOT a)');

  // 우선순위
  check('NOT > AND',            'NOT A AND B',          '((NOT a) AND b)');
  check('AND > OR',             'A OR B AND C',         '(a OR (b AND c))');
  check('NOT > AND > OR',       'A OR NOT B AND C',     '(a OR ((NOT b) AND c))');

  // 괄호
  check('괄호 우선순위',         '(A OR B) AND C',       '((a OR b) AND c)');
  check('중첩 괄호',            '((A OR B) AND C) OR D','(((a OR b) AND c) OR d)');
  check('NOT + 괄호',           'NOT (A OR B)',         '(NOT (a OR b))');

  // 공백 포함 키워드
  check('공백 포함 AND',         '서울 대학교 AND 면접',   '(서울 대학교 AND 면접)');
  check('긴 키워드 + 연산자',    '서울 대학교의 입시 정보 and 면접', '(서울 대학교의 입시 정보 AND 면접)');
  check('한국어 혼합 연산자',    '(영어 OR 수학) NOT 강남','((영어 OR 수학) AND (NOT 강남))');

  // 연속 공백 정규화
  check('연속 공백',            '대학  입시  정보',       '대학 입시 정보');
  check('연산자 주변 공백',      '서울  AND  면접',        '(서울 AND 면접)');

  // 연결성
  check('좌결합 AND',           'A AND B AND C',        '((a AND b) AND c)');
  check('이중 부정',            'NOT NOT A',            '(NOT (NOT a))');

  // 오류 허용
  check('괄호 미닫힘 (자동 닫기)', '(A AND B',           '(a AND b)');
  check('빈 입력',              '',                     'EMPTY');
  check('단독 연산자',           'AND',                  'EMPTY');

  // 연산자 부분 문자열 포함 키워드 — \b 경계 검증
  check('android (and 포함)',   'android',              'android');
  check('notable (not 포함)',   'notable',              'notable');
  check('oracle (or 포함)',     'oracle',               'oracle');
  check('android AND 논술',    'android AND 논술',     '(android AND 논술)');

  Logger.log('──────────────────────────');
  Logger.log('결과: ' + pass + '개 통과 / ' + fail + '개 실패');
  if (fail > 0) throw new Error(fail + '개 테스트 실패');
}

// ── Drive 검색 통합 테스트 (Apps Script 에디터에서 직접 실행) ─────────────────
/**
 * 실제 Drive API를 호출해 파서 → 평가 → 결과 반환 전 흐름을 검증한다.
 *
 * 실행 전 준비:
 *   1. 아래 INTEGRATION_KEYWORD 를 실제로 드라이브에 존재하는 파일명/내용의 단어로 교체
 *   2. Apps Script 편집기에서 testDriveIntegration 선택 후 ▶ 실행
 */
function testDriveIntegration() {
  // ── 여기에 실제 드라이브에 존재하는 키워드 입력 ──────────────────────────
  var KEYWORD_A = '논술';   // 결과가 있어야 하는 키워드
  var KEYWORD_B = '면접';   // 결과가 있어야 하는 키워드
  var KEYWORD_FAKE = 'zzz_절대없는키워드_xqz'; // 결과가 0이어야 하는 키워드
  // ────────────────────────────────────────────────────────────────────────

  var results;

  // 1. 단일 키워드 검색
  Logger.log('=== 1. 단일 키워드: ' + KEYWORD_A + ' ===');
  results = doSearch(KEYWORD_A);
  Logger.log('결과 수: ' + results.length);
  if (results.length === 0) Logger.log('  ⚠ 결과 없음 — 키워드를 실제 파일명/내용으로 교체하세요');
  else Logger.log('  첫 번째 파일: ' + results[0].name + ' (' + results[0].url + ')');

  // 2. AND 검색 — 두 키워드 모두 포함된 파일만
  Logger.log('=== 2. AND: ' + KEYWORD_A + ' AND ' + KEYWORD_B + ' ===');
  results = doSearch(KEYWORD_A + ' AND ' + KEYWORD_B);
  Logger.log('결과 수: ' + results.length + '  (단일 결과보다 적거나 같아야 함)');

  // 3. OR 검색 — 어느 한 쪽만 있어도 포함
  Logger.log('=== 3. OR: ' + KEYWORD_A + ' OR ' + KEYWORD_B + ' ===');
  var orCount = doSearch(KEYWORD_A + ' OR ' + KEYWORD_B).length;
  var aCount  = doSearch(KEYWORD_A).length;
  var bCount  = doSearch(KEYWORD_B).length;
  Logger.log('OR 결과: ' + orCount + ' / A 단독: ' + aCount + ' / B 단독: ' + bCount);
  if (orCount < aCount || orCount < bCount) {
    Logger.log('  ✗ FAIL: OR 결과가 단독 검색보다 작음');
  } else {
    Logger.log('  ✓ PASS');
  }

  // 4. NOT 검색 — KEYWORD_A 있고 KEYWORD_B 없는 파일
  Logger.log('=== 4. NOT: ' + KEYWORD_A + ' NOT ' + KEYWORD_B + ' ===');
  var notCount = doSearch(KEYWORD_A + ' NOT ' + KEYWORD_B).length;
  Logger.log('NOT 결과: ' + notCount + '  (AND 결과보다 적거나 같아야 함)');

  // 5. 존재하지 않는 키워드 → 반드시 0
  Logger.log('=== 5. 가짜 키워드: ' + KEYWORD_FAKE + ' ===');
  results = doSearch(KEYWORD_FAKE);
  if (results.length === 0) Logger.log('  ✓ PASS: 결과 0개');
  else Logger.log('  ✗ FAIL: 가짜 키워드인데 결과가 ' + results.length + '개');

  // 6. 존재하지 않는 키워드 AND 실제 키워드 → 단축 평가로 0
  Logger.log('=== 6. 단축 평가: ' + KEYWORD_FAKE + ' AND ' + KEYWORD_A + ' ===');
  results = doSearch(KEYWORD_FAKE + ' AND ' + KEYWORD_A);
  if (results.length === 0) Logger.log('  ✓ PASS: 단축 평가 정상 동작');
  else Logger.log('  ✗ FAIL: 결과가 ' + results.length + '개');

  // 7. 괄호 포함 복합 쿼리
  Logger.log('=== 7. 복합: (' + KEYWORD_A + ' OR ' + KEYWORD_B + ') NOT ' + KEYWORD_FAKE + ' ===');
  results = doSearch('(' + KEYWORD_A + ' OR ' + KEYWORD_B + ') NOT ' + KEYWORD_FAKE);
  Logger.log('결과 수: ' + results.length + '  (3번 OR 결과와 같아야 함, 가짜 키워드는 아무것도 제거 안 함)');

  // 8. (인문계 OR 자연계) AND 서울대
  Logger.log('=== 8. 복합: (인문계 OR 자연계) AND 서울대 ===');
  var humanCount   = doSearch('인문계').length;
  var naturalCount = doSearch('자연계').length;
  var snu          = doSearch('서울대').length;
  var combined     = doSearch('(인문계 OR 자연계) AND 서울대').length;
  Logger.log('인문계: ' + humanCount + ' / 자연계: ' + naturalCount + ' / 서울대: ' + snu);
  Logger.log('(인문계 OR 자연계) AND 서울대: ' + combined);
  if (combined <= humanCount + naturalCount && combined <= snu) {
    Logger.log('  ✓ PASS');
  } else {
    Logger.log('  ✗ FAIL: AND 결과가 각 단독 결과보다 큼');
  }

  Logger.log('=== 통합 테스트 완료 ===');
}
