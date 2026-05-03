# gdrive-indexr — Docker Deployment Guide

A self-hosted deployment running Node.js + SQLite + Nginx via Docker Compose.

---

## Overview

A self-hosted search engine that lets you search files stored in a Google Drive shared folder — including **file names and file contents** — using keywords.

### How It Works

1. **OAuth Authentication**: Grant this app read access to your Google Drive via Google OAuth.
2. **Indexing**: Once authorized, the app recursively scans the specified folder and stores file metadata (name, path, URL) in a SQLite database. Re-indexing runs automatically every day at 02:00.
3. **Search**: When a query comes in, two paths are searched in parallel:
   - **Local index**: Instant filename/path matching from SQLite
   - **Drive fullText**: Phrase search into file contents via the Google Drive API
   - Results are merged, then filtered to only files present in the local index.
4. **Caching**: Repeated keywords are cached for 6 hours, returning results instantly without calling the Drive API.

### Features

| Feature | Description |
|---------|-------------|
| Boolean search | `AND` `OR` `NOT` operators and parenthesis grouping |
| Phrase search | Searches Drive for exact phrases, including keywords with spaces |
| Auto indexing | Full re-index at 02:00 daily; runs immediately after OAuth login |
| Keyword caching | 6-hour TTL; top 100 keywords pre-warmed automatically |
| Admin panel | Manual index rebuild after password authentication |

---

## Directory Structure

```
docker/
  backend/          Node.js backend (Express, SQLite, Drive API)
  frontend/         Nginx static file server (index.html, nginx.conf)
  data/             Runtime data (excluded from git)
    credentials.json    Google OAuth client credentials
    token.json          OAuth access/refresh token (auto-created after first login)
    database.sqlite     SQLite DB (index, keyword log)
  Dockerfile
  docker-compose.yml
  .env              Environment variables (excluded from git)
  .env.example      Environment variable template
```

---

## Prerequisites

### 1. Google Cloud Project Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or select an existing one)
3. Enable **Google Drive API** under **APIs & Services → Library**

### 2. Configure OAuth Consent Screen

1. In [Google Cloud Console](https://console.cloud.google.com), go to **APIs & Services → OAuth consent screen**
2. User type: select **External** → Create
3. Enter app name and support email, then save and continue
4. Add your Google account email under **Test users**
5. **Publish the app** (switch to production)
   - Without publishing, the `refresh_token` **expires every 7 days**, requiring re-login.
   - No review submission is needed. A private app used only by your own account can run without verification after publishing.
   - If you see a "Google hasn't verified this app" warning at login, click **Advanced → Continue**.

### 3. Create OAuth Client ID

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Web application**
3. Add your callback URL under **Authorized redirect URIs**:
   - Local testing: `http://localhost/oauth/callback`
   - Production domain: `https://your-domain.com/oauth/callback`
   - You can add both if using both environments.
4. Click **Create** → **Download JSON**
5. Save the downloaded file as `docker/data/credentials.json`

> `credentials.json` is excluded from git via `.gitignore`. Never upload it to a public repository.

---

## Deployment

### Step 1 — Clone the repository

```bash
git clone https://github.com/itmir913/gdrive-indexr-webapps.git
cd gdrive-indexr-webapps/docker
```

### Step 2 — Create the data directory and place credentials.json

```bash
mkdir -p data
# Copy the downloaded file to data/credentials.json
cp /path/to/downloaded-credentials.json data/credentials.json
```

### Step 3 — Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in the values:

```dotenv
# Root folder ID of the Google Drive folder to search
# Drive URL: https://drive.google.com/drive/folders/<FOLDER_ID>
FOLDER_ID=your_root_folder_id

# Admin password (plain text — hashed with SHA-256 on the client before sending)
ADMIN_PASSWORD=your_password

# OAuth callback URI (must exactly match the Authorized redirect URI in Google Cloud Console)
OAUTH_REDIRECT_URI=https://your-domain.com/oauth/callback
```

### Step 4 — Build and run

```bash
docker compose up -d --build
```

### Step 5 — Check logs

```bash
docker compose logs -f backend
```

If you see the following messages, the server is running correctly:

```
[2026-05-03 15:08:11]  [INFO ]  [Server   ]  Listening on port [3000]
[2026-05-03 15:08:11]  [WARN ]  [Auth     ]  Unauthenticated — please sign in with Google via the admin modal in the frontend
```

---

## First-time Authentication (OAuth Login)

1. Open `https://your-domain` (or `http://localhost`) in your browser
2. Click the **⚙️** button at the bottom-right → enter the admin password
3. Click **Sign in with Google** → select your account → allow access
4. The page returns to the main screen and Drive indexing starts automatically
5. Once the status badge in the header shows **OK**, search is ready

> After login, `docker/data/token.json` is created automatically. As long as this file exists, authentication is maintained across server restarts without re-logging in.

---

## SSL / Cloudflare + Nginx Proxy Manager

Choose one of two SSL options:

- **Nginx direct SSL**: Uncomment the SSL-related lines in `docker-compose.yml` and `nginx.conf`.
- **External SSL** (Cloudflare, Nginx Proxy Manager, etc.): The internal Nginx handles only HTTP(80); SSL is terminated externally.

To set up with Nginx Proxy Manager:

1. Add a new Proxy Host in NPM:
   - **Domain Names**: `your-domain.com`
   - **Forward Hostname/IP**: Docker host IP (or container name)
   - **Forward Port**: `80`
   - **SSL**: Enable Let's Encrypt certificate
2. Set `OAUTH_REDIRECT_URI` in `.env` to `https://your-domain.com/oauth/callback`
3. Add the same address to **Authorized redirect URIs** in Google Cloud Console
4. Re-run `docker compose up --build -d`

For local testing, you can use HTTP without SSL. Set `OAUTH_REDIRECT_URI` in `.env` to `http://localhost/oauth/callback` and register the same URI in Google Cloud Console.

---

## Index Management

| Method | Description |
|--------|-------------|
| Initial | Runs automatically right after OAuth login |
| Automatic | Full re-index every day at 02:00 |
| Manual | Click ⚙️ at the bottom-right → enter password → start rebuild |

---

## Health Check

The backend container calls `/api/health` every 30 seconds.

```bash
# Check container status
docker compose ps

# Manually check health check response
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
