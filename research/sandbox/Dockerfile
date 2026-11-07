# Sandbox cách ly để test bot — chỉ chứa dependencies, code được bơm vào lúc chạy (không mount thư mục máy host).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && chown -R node:node /app
USER node
