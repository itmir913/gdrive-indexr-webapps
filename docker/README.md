# gdrive-indexr — Docker 배포 가이드

Node.js + SQLite + Nginx를 Docker Compose로 실행하는 자체 호스팅 배포 방식입니다.

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

1. **API 및 서비스 → OAuth 동의 화면** 이동
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

## 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일을 열어 값을 입력합니다.

```dotenv
# Google Drive 루트 폴더 ID
# Drive URL: https://drive.google.com/drive/folders/<FOLDER_ID>
FOLDER_ID=your_root_folder_id

# 관리자 비밀번호 (평문 — 클라이언트에서 SHA-256 해싱 후 전송)
ADMIN_PASSWORD=your_password

# OAuth 콜백 URI (Google Cloud Console의 승인된 리디렉션 URI와 정확히 일치해야 함)
OAUTH_REDIRECT_URI=https://your-domain.com/oauth/callback
```

---

## 실행

```bash
docker compose up --build -d
```

---

## 최초 인증 (OAuth 로그인)

1. 브라우저에서 `https://your-domain` (또는 `http://localhost`) 접속
2. Google 로그인 페이지로 자동 리디렉션됨
3. 본인 계정으로 로그인 → 권한 허용
4. 메인 페이지로 돌아오면서 Drive 인덱싱 자동 시작
5. 헤더의 상태 뱃지가 **정상** 으로 바뀌면 검색 가능

> 로그인 후 `docker/data/token.json` 이 자동 생성됩니다. 이 파일이 있으면 서버 재시작 시 재로그인 없이 인증이 유지됩니다.

---

## Cloudflare + Nginx Proxy Manager 연동

NPM이 SSL을 담당하므로 내부 nginx는 HTTP(80)만 사용합니다.

1. NPM에서 새 Proxy Host 추가
   - **Domain Names**: `your-domain.com`
   - **Forward Hostname/IP**: Docker 호스트 IP (또는 컨테이너명)
   - **Forward Port**: `80`
   - **SSL**: Let's Encrypt 인증서 발급 활성화
2. `.env` 의 `OAUTH_REDIRECT_URI` 를 `https://your-domain.com/oauth/callback` 으로 설정
3. Google Cloud Console의 **승인된 리디렉션 URI** 에도 동일 주소 추가
4. `docker compose up --build -d` 재실행

---

## 인덱스 관리

| 방법 | 설명 |
|------|------|
| 자동 | 매일 02:00 전체 재인덱싱 |
| 수동 | 화면 우하단 ⚙️ → 비밀번호 입력 → 갱신 시작 |
| 최초 | OAuth 로그인 직후 자동 실행 |

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
