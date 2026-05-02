# ── Stage 1: 백엔드 ──────────────────────────────────────────────────────────
FROM node:20 AS backend

WORKDIR /app

COPY backend/package*.json ./
RUN npm install

COPY backend/ .
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["npm", "start"]

# ── Stage 2: 프론트엔드 (nginx) ───────────────────────────────────────────────
FROM nginx:latest AS frontend

COPY frontend/index.html /usr/share/nginx/html/index.html
COPY frontend/nginx.conf /etc/nginx/templates/default.conf.template
