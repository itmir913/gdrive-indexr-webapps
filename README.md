# Google Drive 통합검색 시스템

[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT) [![GDrive Indexr](https://img.shields.io/badge/Website-GDrive_Indexr-blue.svg)](https://luminousky.com/teacher-utility-kit/gdrive-indexr/)

<img width="70%" alt="Snipaste_2026-05-03_16-23-58" src="https://github.com/user-attachments/assets/e1e018ad-cd29-4569-9806-941a2b2a18d5" />

**GDrive Indexr**는 사용자의 Google Drive 폴더 내 파일명과 본문까지 Boolean 키워드로 빠르고 정교하게 찾아주는 통합 웹 검색 엔진입니다.

---

## ✨ 주요 기능 (Features)

* **구글 드라이브 엔진 기반의 강력한 검색**
    * Google Drive의 공식 검색 알고리즘을 그대로 활용하여 신뢰도 높고 빠른 검색 성능을 제공합니다.
    * 파일명은 물론, **PDF 파일 내부 텍스트** 및 각종 문서 본문 내용까지 깊이 있게 탐색합니다.

* **복합 조건 검색 (Boolean Operators)**
    * `AND`, `OR`, `NOT` 등의 연산자를 활용하여 여러 개의 키워드를 조합한 복합 조건 검색이 가능합니다.
    * 방대한 자료 사이에서 노이즈를 줄이고 원하는 결과만 정확하게 필터링할 수 있습니다.

## 🛠 기술적 특징 및 배포 (Deployment)

이 프로젝트는 사용자의 환경에 맞춰 유연하게 구현 및 확장이 가능합니다.

* **다양한 구현 방식 지원**:
    * **Google Apps Script (GAS)**: 별도의 서버 구축 없이 구글 환경 내에서 가볍고 빠르게 배포할 수 있습니다.
    * **Self-Hosted Server**: 필요한 경우 직접 서버를 운영하여 독립적인 웹 서비스로 호스팅할 수 있습니다.

---

## 배포 방식 선택

두 가지 배포 방식을 제공합니다.

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
