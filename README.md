# 구글 드라이브 통합검색 시스템

구글 드라이브 공유 폴더에 저장된 자료를 파일명·파일 내용까지 Boolean 키워드로 검색할 수 있는 웹 검색 엔진입니다.

두 가지 배포 방식을 제공합니다.

---

## 배포 방식 선택

### Google Apps Script (서버리스)

> 별도 서버 없이 Google Drive + Apps Script만으로 동작합니다.

- 외부 서버·도메인 불필요
- Google 계정만 있으면 무료 운영 가능
- 설정이 간단하고 유지보수 부담 없음
- 동시 접속 약 30명 제한
- Boolean 연산자 지원: `AND`, `OR`, `NOT`, 괄호 그룹

→ [`src/README.md`](src/README.md) 참고

---

### Node.js + Docker (자체 서버)

> Express 백엔드 + SQLite + nginx를 Docker로 직접 호스팅합니다.

- 자체 도메인·서버 필요
- 더 빠른 검색 응답 (로컬 인덱스 + Drive fullText 구문 검색 병렬 조회)
- Cloudflare + Nginx Proxy Manager 연동 지원
- OAuth 2.0 기반 접근 제어
- Boolean 연산자 지원: `AND`, `OR`, `NOT`, 괄호 그룹

→ [`docker/README.md`](docker/README.md) 참고

---

## 라이선스

[MIT License](LICENSE.md)
