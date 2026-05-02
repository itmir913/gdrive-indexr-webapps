# 1. 베이스 이미지 선택
# sqlite3 빌드 시 필요한 빌드 도구(Python, g++)가 포함된 기본 Node 20 버전 사용
FROM node:20

# 2. 컨테이너 내 작업 디렉토리 생성
WORKDIR /app

# 3. 의존성 설치
# package.json과 package-lock.json을 먼저 복사하여 캐시 활용
COPY package*.json ./
RUN npm install

# 4. 나머지 소스 코드 복사
COPY . .

# 5. SQLite DB와 서비스 계정 키가 들어갈 데이터 폴더 생성
# (실제 데이터는 docker-compose의 볼륨을 통해 호스트와 연결됩니다)
RUN mkdir -p /app/data

# 6. 백엔드 앱 포트 노출 (익스프레스 서버용)
EXPOSE 3000

# 7. 애플리케이션 실행
CMD ["npm", "start"]