# ── Stage 1: 백엔드 ──────────────────────────────────────────────────────────
FROM node:20 AS backend

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm install

COPY backend/*.js ./
RUN mkdir -p /app/data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1
CMD ["npm", "start"]

# ── Stage 2: 프론트엔드 (nginx) ───────────────────────────────────────────────
FROM nginx:latest AS frontend

COPY frontend/index.html /usr/share/nginx/html/index.html
COPY frontend/nginx.conf /etc/nginx/templates/default.conf.template
