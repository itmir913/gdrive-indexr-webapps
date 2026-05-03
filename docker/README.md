# gdrive-indexr — Docker 배포 가이드

Node.js + SQLite + Nginx를 Docker Compose로 실행하는 자체 호스팅 배포 방식입니다.

---

## 개요

Google Drive 공유 폴더에 저장된 파일을 **파일명과 파일 내용까지** 키워드로 검색할 수 있는 자체 호스팅 검색 엔진입니다.

### 동작 원리

1. **OAuth 인증**: 사용자가 Google OAuth를 통해 이 앱에 Google Drive 읽기 권한을 부여합니다.
2. **인덱싱**: 권한이 부여되면 지정한 폴더를 재귀적으로 전체 탐색하여 파일 메타데이터(파일명, 경로, URL)를 SQLite DB에 저장합니다. 이후 매일 02:00에 자동으로 재인덱싱됩니다.
3. **검색**: 검색어가 들어오면 두 경로를 병렬로 조회합니다.
   - **로컬 인덱스**: SQLite에서 파일명·경로 기준 즉시 매칭
   - **Drive fullText**: Google Drive API로 파일 내용까지 구문(phrase) 검색
   - 두 결과를 합산한 뒤 로컬 인덱스에 등록된 파일만 반환합니다.
4. **캐싱**: 동일 키워드는 6시간 동안 캐싱하여 Drive API 호출 없이 즉시 반환합니다.

### 지원 기능

| 기능 | 설명                                   |
|------|--------------------------------------|
| Boolean 검색 | `AND` `OR` `NOT` 연산자 및 괄호 그룹 지원      |
| 구문 검색 | 공백 포함 키워드를 정확한 구문으로 Drive 검색         |
| 자동 인덱싱 | 매일 02:00 전체 재인덱싱, OAuth 로그인 직후 즉시 실행 |
| 키워드 캐싱 | 6시간 TTL, 자주 검색된 상위 100개 키워드 사전 워밍    |
| 관리자 기능 | 비밀번호 인증 후 인덱스 수동 재빌드 가능              |

---

## 디렉토리 구조

```
docker/
  backend/          Node.js 백엔드 (Express, SQLite, Drive API)
  frontend/         nginx 정적 파일 서버 (index.html, nginx.conf)
  data/             런타임 데이터 (git 제외)
    credentials.json    Google OAuth 클라이언트 인증 파일
    token.json          OAuth 액세스/리프레시 토큰 (최초 로그인 후 자동 생성)
    database.sqlite     SQLite DB (인덱스, 키워드 로그)
  Dockerfile
  docker-compose.yml
  .env              환경변수 (git 제외)
  .env.example      환경변수 템플릿
```

---

## 사전 준비

### 1. Google Cloud 프로젝트 설정

1. [Google Cloud Console](https://console.cloud.google.com) 접속
2. 프로젝트 생성 (또는 기존 프로젝트 선택)
3. **API 및 서비스 → 라이브러리** 에서 **Google Drive API** 활성화

### 2. OAuth 동의 화면 구성

1. [Google Cloud Console](https://console.cloud.google.com)에서, **API 및 서비스 → OAuth 동의 화면** 이동
2. 사용자 유형: **외부** 선택 → 만들기
3. 앱 이름, 지원 이메일 입력 후 저장 및 계속
4. **테스트 사용자** 섹션에서 본인 Google 계정 이메일 추가
5. **앱 게시** (프로덕션으로 전환)
   - 게시하지 않으면 `refresh_token`이 **7일마다 만료**되어 재로그인이 필요합니다.
   - 심사 신청은 불필요합니다. 본인 계정만 사용하는 비공개 앱은 게시 후에도 검증 없이 운영 가능합니다.
   - 로그인 시 "Google의 검증을 받지 않은 앱" 경고창이 뜨면 **고급 → 계속** 을 클릭하면 됩니다.

### 3. OAuth 클라이언트 ID 발급

1. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
2. 애플리케이션 유형: **웹 애플리케이션** 선택
3. **승인된 리디렉션 URI** 에 콜백 주소 추가:
   - 로컬 테스트: `http://localhost/oauth/callback`
   - 실제 도메인: `https://your-domain.com/oauth/callback`
   - 두 환경을 모두 사용한다면 둘 다 추가해도 됩니다.
4. **만들기** → **JSON 다운로드**
5. 다운로드한 파일을 `docker/data/credentials.json` 으로 저장

> `credentials.json` 은 `.gitignore` 에 의해 git에서 제외됩니다. 절대 공개 저장소에 올리지 마세요.




---

## 배포

### 1단계 — 저장소 복제 및 이동

```bash
git clone https://github.com/itmir913/gdrive-indexr-webapps.git
cd gdrive-indexr-webapps/docker
```

### 2단계 — data 디렉토리 생성 및 credentials.json 배치

```bash
mkdir -p data
# GCP에서 다운로드한 파일을 data/credentials.json 으로 복사
cp /path/to/downloaded-credentials.json data/credentials.json
```

### 3단계 — 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일을 열어 값을 입력합니다.

```dotenv
# Google Drive 검색 대상 루트 폴더 ID
# Drive URL: https://drive.google.com/drive/folders/<FOLDER_ID>
FOLDER_ID=your_root_folder_id

# 관리자 비밀번호 (평문 — 클라이언트에서 SHA-256 해싱 후 전송)
ADMIN_PASSWORD=your_password

# OAuth 콜백 URI (Google Cloud Console의 승인된 리디렉션 URI와 정확히 일치해야 함)
OAUTH_REDIRECT_URI=https://your-domain.com/oauth/callback
```

### 4단계 — 빌드 및 실행

```bash
docker compose up -d --build
```

### 5단계 — 로그 확인

```bash
docker compose logs -f backend
```

아래와 같은 메시지가 출력되면 정상 실행된 것입니다.

```
[2026-05-03 15:08:11]  [INFO ]  [Server   ]  포트 [3000]에서 가동 중
[2026-05-03 15:08:11]  [WARN ]  [Auth     ]  미인증 상태 — 프론트엔드 관리자 모달에서 Google 로그인 필요
```

---

## 최초 인증 (OAuth 로그인)

1. 브라우저에서 `https://your-domain` (또는 `http://localhost`) 접속
2. 화면 우하단 **⚙️** 버튼 클릭 → 관리자 비밀번호 입력
3. **Google 로그인** 버튼 클릭 → Google 계정 선택 → 권한 허용
4. 메인 페이지로 돌아오면서 Drive 인덱싱 자동 시작
5. 헤더의 상태 뱃지가 **정상** 으로 바뀌면 검색 가능

> 로그인 후 `docker/data/token.json` 이 자동 생성됩니다. 이 파일이 있으면 서버 재시작 시 재로그인 없이 인증이 유지됩니다.

---

## Cloudflare + Nginx Proxy Manager 연동

SSL 연결 방식은 두 가지 중 선택합니다.

- **Nginx 직접 SSL**: `docker-compose.yml`, `nginx.conf` 의 SSL 관련 주석을 해제하세요.
- **외부 서비스 SSL** (Cloudflare, Nginx Proxy Manager 등): 내부 Nginx는 HTTP(80)만 사용하고 SSL은 외부에서 처리합니다.

1. NPM에서 새 Proxy Host 추가
   - **Domain Names**: `your-domain.com`
   - **Forward Hostname/IP**: Docker 호스트 IP (또는 컨테이너명)
   - **Forward Port**: `80`
   - **SSL**: Let's Encrypt 인증서 발급 활성화
2. `.env` 의 `OAUTH_REDIRECT_URI` 를 `https://your-domain.com/oauth/callback` 으로 설정
3. Google Cloud Console의 **승인된 리디렉션 URI** 에도 동일 주소 추가
4. `docker compose up --build -d` 재실행

로컬 테스트 환경에서는 SSL 없이 HTTP로 사용할 수 있습니다. 이 경우 `.env`의 `OAUTH_REDIRECT_URI`를 `http://localhost/oauth/callback`으로 설정하고, Google Cloud Console의 승인된 리디렉션 URI에도 동일하게 등록하세요.

---

## 인덱스 관리

| 방법 | 설명                              |
|------|---------------------------------|
| 최초 | OAuth 로그인 직후 자동 실행              |
| 자동 | 매일 02:00 전체 재인덱싱                |
| 수동 | 화면 우하단 ⚙️ → 관리자 비밀번호 입력 → 갱신 시작 |

---

## 헬스체크

백엔드 컨테이너는 30초마다 `/api/health` 를 호출합니다.

```bash
# 컨테이너 상태 확인
docker compose ps

# 헬스체크 응답 직접 확인
curl http://localhost:3000/api/health
```

```json
{
  "status": "ok",
  "uptime": 3612,
  "authenticated": true,
  "isIndexing": false,
  "indexedCount": 1024
}
```
