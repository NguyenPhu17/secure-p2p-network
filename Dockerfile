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
# Stage 2: Cài production dependencies
# =======================================================
FROM node:22-alpine AS prod-deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# =======================================================
# Stage 3: Production runtime tối giản (non-root, bỏ npm/yarn/corepack)
# =======================================================
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Gỡ bỏ npm/npx/corepack/yarn không dùng ở runtime để thu gọn attack surface và loại bỏ CVE từ CLI
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /opt/yarn*

COPY package.json config.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Tạo thư mục downloads, logs và phân quyền cho user non-root 'node' (UID 1000)
RUN mkdir -p downloads logs && chown -R node:node /app

USER node

EXPOSE 4000 7000

CMD ["node", "dist/manager/index.js"]
