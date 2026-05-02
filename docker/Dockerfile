# ── Stage 1: 백엔드 ──────────────────────────────────────────────────────────
FROM node:20 AS backend

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["npm", "start"]

# ── Stage 2: 프론트엔드 (nginx) ───────────────────────────────────────────────
FROM nginx:latest AS frontend

COPY --from=backend /app/frontend /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template
