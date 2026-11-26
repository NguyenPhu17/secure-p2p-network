# =======================================================
# Stage 1: Build mã nguồn React UI bằng Vite & TypeScript
# =======================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Tận dụng cơ chế layer cache của Docker cho node_modules
COPY package*.json ./
RUN npm ci

# Sao chép toàn bộ mã nguồn Frontend và tiến hành biên dịch
COPY . .
RUN npm run build

# =======================================================
# Stage 2: Phục vụ ứng dụng qua Web Server Nginx Alpine
# =======================================================
FROM nginx:alpine

# Sao chép thư mục dist đã biên dịch vào thư mục phục vụ web của Nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# Sao chép cấu hình Nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
