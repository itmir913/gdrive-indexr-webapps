# Google Drive Full-Text Search Web App

[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT) [![GDrive Indexr](https://img.shields.io/badge/Website-GDrive_Indexr-blue.svg)](https://luminousky.com/teacher-utility-kit/gdrive-indexr/)


<img width="70%" alt="Snipaste_2026-05-03_23-35-26" src="https://github.com/user-attachments/assets/f7428055-edeb-47ae-928e-73bd024b388e" />


A web search engine that lets you search files stored in a Google Drive shared folder by filename and file contents using Boolean keywords.

---

## Choose a Deployment Option

Two deployment options are available.

### Google Apps Script (Serverless)

> Runs entirely on Google Drive + Apps Script — no external server required.

- No server or domain needed
- Free to operate with just a Google account
- Simple setup with minimal maintenance
- ~30 concurrent users limit
- Boolean operators supported: `AND`, `OR`, `NOT`, parenthesis grouping

→ See [`src/README.en.md`](src/README.en.md)

---

### Node.js + Docker (Self-hosted)

> Host your own Express backend + SQLite + Nginx via Docker.

- Requires your own domain and server
- Faster search response (local index + Drive fullText phrase search in parallel)
- Cloudflare + Nginx Proxy Manager integration supported
- OAuth 2.0 based access control
- Boolean operators supported: `AND`, `OR`, `NOT`, parenthesis grouping

→ See [`docker/README.en.md`](docker/README.en.md)

---

## License

[MIT License](LICENSE.md)
