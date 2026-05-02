# 구글 드라이브 키워드 기반 통합검색 시스템

구글 드라이브 공유 폴더에 저장된 자료를 파일 내부까지 키워드로 빠르게 검색할 수 있는 Google Apps Script 웹앱입니다.

외부 서버·회원가입 없이 Google Drive + Apps Script + Google Sheets만으로 동작합니다.

## 주요 기능

- **파일명 + 모든 파일 내부 텍스트 동시 검색** (Drive API v3 `fullText contains` 활용)
- **Boolean 연산자** 지원: `AND`, `OR`, `NOT`, `(` `)` 괄호 그룹
- **6시간 캐싱** (CacheService) — 동일 키워드 재검색 시 Drive API 호출 없이 즉시 반환
- **하루 1회 인덱스 자동 갱신** (02:00 트리거) + **하루 4회 캐시 워밍** (02:30 / 07:30 / 12:30 / 17:30)
- **키워드 빈도 로그** — 검색어를 익명으로 수집해 캐시 워밍 우선순위에 활용 (3일 미검색 키워드는 매일 03:00 자동 삭제)
---

## 초기 설정 방법 (배포 전 필수 작업)

구글 드라이브 통합검색 시스템을 구현하기 위해 아래 단계를 그대로 따라 진행하세요.

### 1단계 — Google 스프레드시트 생성

1. [Google Sheets](https://sheets.google.com)에서 새 스프레드시트를 생성합니다.
2. 기본 시트 이름을 **`FileIndex`** 로 변경합니다.
3. 시트를 하나 더 추가하고 이름을 **`KeywordLog`** 로 지정합니다.
4. 스프레드시트 URL에서 ID를 복사합니다.
   ```
   https://docs.google.com/spreadsheets/d/[여기가 ID]/edit
   ```

### 2단계 — 구글 드라이브 폴더 ID 확인

검색 대상 파일이 담긴 최상단 루트 폴더를 열고 URL에서 폴더 ID를 복사합니다.

```
https://drive.google.com/drive/folders/[여기가 ID]
```

### 3단계 — Apps Script 프로젝트 생성 및 코드 붙여넣기

1. 스프레드시트 메뉴 → **확장 프로그램 → Apps Script** 를 엽니다.
2. 기본 `Code.gs` 내용을 모두 지우고 이 저장소의 `src/Code.gs` 파일 내용을 붙여넣습니다.
3. `+` 버튼으로 HTML 파일을 추가하고 이름을 **`index`** 로 지정한 뒤 `src/index.html` 내용을 붙여넣습니다.

### 4단계 — 상수 값 교체

`Code.gs` 파일 상단의 두 상수를 실제 값으로 교체합니다.

```js
const FOLDER_ID      = 'your_root_folder_id';   // 2단계에서 복사한 폴더 ID
const INDEX_SHEET_ID = 'your_spreadsheet_id';   // 1단계에서 복사한 스프레드시트 ID
```

### 5단계 — Drive API v3 활성화

1. Apps Script 편집기 왼쪽 사이드바에서 **서비스(+)** 를 클릭합니다.
2. 목록에서 **Drive API** 를 선택합니다.
3. 버전을 **v3** 으로 설정하고 식별자를 **`Drive`** 로 유지한 뒤 추가합니다.

### 6단계 — 최초 인덱스 빌드

Apps Script 편집기에서 함수를 선택해 수동으로 실행합니다. 함수는 `실행` 버튼과 `디버그` 버튼 옆에 있습니다.

```
rebuildMetadataIndex 선택 후 실행 버튼 클릭 → FileIndex 시트에 PDF 목록이 채워지는지 확인
```

> 실행 시 드라이브 접근 권한 요청 팝업이 뜨면 허용합니다.

### 7단계 — 트리거 설치

```
setupTriggers 선택 후 실행 버튼 클릭 → Apps Script 좌측 편집기 → 트리거 메뉴 확인
```

### 8단계 — 웹앱 배포

1. Apps Script 편집기 우측 상단 **배포 → 새 배포** 를 클릭합니다.
2. 유형: **웹 앱**
3. 설정:
   - 다음 사용자 인증 정보로 실행: **나 (스크립트 소유자)**
   - 액세스 권한이 있는 사용자: **모든 사용자**
4. 배포 후 표시되는 **웹앱 URL** 을 교사들에게 공유합니다.

> 만약 파일 검색 웹앱 자체를 Google 로그인한 사람만 접근할 수 있도록 설정하려면, `액세스 권한이 있는 사용자`를 **Google 계정이 있는 모든 사용자**로 설정하면 됩니다.

---

## 접근 권한 구조

웹앱 링크를 알고 있는 사람은 누구나 검색 결과(파일 목록)를 확인할 수 있습니다.
파일을 실제로 열 수 있는지는 Google Drive 폴더의 공유 설정에 따라 별도로 결정됩니다.

- **시나리오 1 — 누구나 파일까지 열 수 있게 하려면**

  Drive 루트 폴더 공유 설정을 **"링크가 있는 모든 사용자 → 뷰어"** 로 지정합니다. 검색 결과 링크를 클릭하면 로그인 없이 바로 파일이 열립니다.

- **시나리오 2 — 내부 구성원만 파일을 열 수 있게 하려면**

  Drive 루트 폴더 공유 설정에서 허용할 Google 계정을 직접 추가합니다. 권한이 없는 사용자가 파일 링크를 클릭하면 "액세스 요청" 화면이 표시됩니다. 학년부 등 특정 팀 전용 내부 자료 검색기로 운영할 때 적합합니다.

---

## 검색 예시

| 입력                  | 동작 |
|---------------------|------|
| `예체능 AND 서울 AND 입결` | 세 키워드 모두 포함 (AND) |
| `수학 OR 영어`          | 둘 중 하나 포함 |
| `수학 NOT 서울`         | 수학 포함, 서울 미포함 |
| `(수학 OR 영어) NOT 서울` | 괄호로 우선순위 지정 |

---

## 파일 구성

```
Code.gs      — 백엔드 (검색, 인덱싱, 캐시, 트리거, Boolean 파서)
index.html   — 검색 UI
```

## 아키텍처

```
브라우저 (index.html)
  └─ google.script.run.doSearch(query)
        └─ tokenize → buildExpressionTree → evaluate
              └─ getFileIdsForKeyword(keyword)
                    ├─ CacheService 히트 → fileId 배열 즉시 반환
                    └─ 미스 → Drive API fullText 검색 → 캐시 저장
              └─ 집합 연산 (AND 교집합 / OR 합집합 / NOT 차집합)
        └─ lookupMetadata(fileIds) — Sheets FileIndex 시트 조회

스케줄 트리거
  02:00  rebuildMetadataIndex — FileIndex 시트 전체 재빌드
  02:30  warmCache            — 상위 100개 키워드 캐시 사전 워밍
  03:00  purgeStaleKeywords   — 3일 미검색 키워드 KeywordLog에서 삭제
  07:30  warmCache
  12:30  warmCache
  17:30  warmCache
```

## 스프레드시트 구조

| 시트 이름 | 역할 | 컬럼 |
|-----------|------|-------|
| `FileIndex` | 파일 메타데이터 인덱스 | fileId \| 파일명 \| 폴더경로 \| URL \| 수정일 |
| `KeywordLog` | 키워드 빈도 로그 | 키워드 \| 검색횟수 \| 마지막검색일 |

## 상수 설명

| 상수 | 기본값 | 설명 |
|------|--------|------|
| `FOLDER_ID` | _(교체 필요)_ | 검색 대상 루트 폴더 ID |
| `INDEX_SHEET_ID` | _(교체 필요)_ | 스프레드시트 ID |
| `FILE_INDEX_SHEET` | `FileIndex` | 메타데이터 시트 이름 |
| `KEYWORD_LOG_SHEET` | `KeywordLog` | 키워드 로그 시트 이름 |
| `CACHE_TTL` | `21600` | 캐시 유효시간 (초, Google 하드 리밋) |
| `CACHE_CHUNK_SIZE` | `30000` | 청크 캐시 분할 크기 (한글 3바이트 기준 90KB/청크) |
| `PRECACHE_TOP_N` | `100` | 캐시 워밍 대상 상위 키워드 수 |
| `DRIVE_SERVICE` | `Drive` | Drive API 서비스 식별자 |
| `ADMIN_PASSWORD` | `admin1234` | 관리자 인증 비밀번호 (배포 전 반드시 변경) |
