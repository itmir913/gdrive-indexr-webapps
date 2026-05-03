# Google Drive Unified Search System

A web search engine that lets you search files stored in a Google Drive shared folder by filename and file contents using Boolean keywords.

Two deployment options are available.

---

## Choose a Deployment Option

### Google Apps Script (Serverless)

> Runs entirely on Google Drive + Apps Script — no external server required.

- No server or domain needed
- Free to operate with just a Google account
- Simple setup with minimal maintenance
- ~30 concurrent users limit
- Boolean operators supported: `AND`, `OR`, `NOT`, parenthesis grouping

→ See [`src/README.md`](src/README.md)

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
