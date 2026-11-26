# =======================================================
# Stage 1: Biên dịch TypeScript -> dist/
# =======================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Cài dependencies chuẩn theo package-lock.json
COPY package*.json tsconfig.json tsconfig.build.json ./
RUN npm ci

# Sao chép mã nguồn backend và biên dịch
COPY common/ ./common/
COPY registry/ ./registry/
COPY peer/ ./peer/
COPY manager/ ./manager/
RUN npm run build

# =======================================================
# Stage 2: Production runtime (non-root, chỉ giữ prod deps)
# =======================================================
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json config.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Tạo thư mục downloads, logs và phân quyền cho user non-root 'node' (UID 1000)
RUN mkdir -p downloads logs && chown -R node:node /app

USER node

EXPOSE 4000 7000

CMD ["node", "dist/manager/index.js"]

