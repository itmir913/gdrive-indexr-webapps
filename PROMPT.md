# 구글 드라이브 기반 입시정보 통합 검색 시스템 구현

## 배경
한국 학교 교사들이 구글 드라이브 공유 폴더에 입시 자료(PDF)를 올리면,
담임/담당 교사가 키워드로 빠르게 검색할 수 있는 시스템을 Apps Script로 구현한다.
외부 서버 없음, 회원가입 없음, 구글 드라이브 + Apps Script 웹앱만 사용.

## 파일 환경
- 거의 전부 PDF (텍스트 기반, 스캔본 아님)
- Google Workspace for Education 계정 사용
- 폴더 구조 자체가 태그 역할 (예: 예체능/서울/2025_서울대_입결.pdf)

## 검색 스펙
- 공백 = AND 연산 ("예체능 서울 입결" → 세 키워드 모두 포함한 파일)
- 파일명 + PDF 내부 텍스트까지 검색 대상
- Drive API fullText contains 사용 (Google이 자동 생성한 PDF 인덱스 활용)

## 아키텍처

### 스프레드시트 구성 (시트 2개)
시트1 - 파일 메타데이터 (새벽 2:00 트리거로 하루 1회 갱신)
컬럼: fileId | 파일명 | 폴더경로(태그) | URL | 수정일

시트2 - 키워드 빈도 로그 (검색할 때마다 누적)
컬럼: 키워드 | 검색횟수 | 마지막검색일

### CacheService (키워드 단위 캐싱)
- 저장 내용: 키워드 → fileId 배열 (메타데이터 아님, 용량 최소화)
- TTL: 21600초 (6시간, Google 하드 리밋)
- 캐시 키 형식: 'kw_예체능', 'kw_서울'

### 검색 흐름
1. 쿼리를 공백으로 분리 → 키워드 배열
2. 시트2에 각 키워드 빈도 +1 기록
3. 키워드별로 CacheService 확인
    - 히트 → fileId 배열 즉시 반환
    - 미스 → Drive API fullText 검색 → 결과 캐시 저장
4. fileId 배열들의 교집합 계산 (AND 연산)
5. 교집합 fileId로 시트1에서 메타데이터 조회
6. 결과 반환 (파일명, 폴더경로, URL)

### 트리거 스케줄
- 02:00 rebuildMetadataIndex (하루 1회)
- 02:30 warmCache (캐시 워밍 1회차)
- 07:30 warmCache (캐시 워밍 2회차) ← 출근 직전
- 12:30 warmCache (캐시 워밍 3회차) ← 점심
- 17:30 warmCache (캐시 워밍 4회차) ← 업무 마감 전

### warmCache 로직
- 시트2에서 검색횟수 기준 상위 30개 키워드 추출
- 각 키워드에 대해 캐시 존재 여부 확인
    - 캐시 없을 때만 Drive API 호출 후 저장 (있으면 스킵, API 절약)
- Utilities.sleep(200) 으로 API 속도 제한 대응

## 구현할 파일 목록
1. Code.gs
    - doGet(e)
    - doSearch(query) ← 웹앱 클라이언트에서 google.script.run으로 호출
    - logKeywords(keywords)
    - getFileIdsForKeyword(keyword)
    - driveFullTextSearch(keyword)
    - lookupMetadata(fileIds)
    - rebuildMetadataIndex()
    - getAllFilesRecursive(folderId, pathPrefix)
    - warmCache()
    - setupTriggers()

2. index.html
    - 검색창 (공백 AND 연산 안내 포함)
    - "검색어는 서비스 개선을 위해 익명으로 수집됩니다" 문구
    - 결과: 파일명, 폴더경로(태그), 드라이브 열기 링크
    - 로딩 상태 표시

## 상수 (구현 시 실제 값으로 교체)
const FOLDER_ID      = 'your_root_folder_id';
const INDEX_SHEET_ID = 'your_spreadsheet_id';
const CACHE_TTL      = 21600;
const PRECACHE_TOP_N = 30;


## 검색 연산자 확장

공백 입력 시 AND로 자동 처리 (기존 방식 유지).
명시적 연산자 지원:
AND → 교집합
OR  → 합집합
NOT → 전체 fileId(시트1) - 해당 키워드 fileId
()  → 우선순위 그룹

구현 방식:
- tokenize() → buildExpressionTree() → evaluate() 순서의 쿼리 파서
- evaluate()는 각 키워드에 대해 기존 getFileIdsForKeyword() 호출
- 집합 연산은 Apps Script(Code.gs) 내부에서 처리
- Drive API 추가 호출 없음

UI:
- 검색창 하단에 AND / OR / NOT / ( ) 힌트 버튼 제공
- 버튼 클릭 시 검색창에 해당 연산자 삽입