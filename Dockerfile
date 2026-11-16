FROM node:22-alpine

WORKDIR /app

# Sao chép file cấu hình và dependencies
COPY package*.json tsconfig.json config.json ./
RUN npm install

# Sao chép mã nguồn backend
COPY common/ ./common/
COPY registry/ ./registry/
COPY peer/ ./peer/

# Tạo thư mục downloads, logs
RUN mkdir -p downloads logs

CMD ["npm", "run", "registry"]

