#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
CONTAINER_NAME="${POSTGRES_CONTAINER:-p2p-postgres}"

if [ -f "${PROJECT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_DIR}/.env"
  set +a
fi

DB_NAME="${DB_NAME:-p2p_network}"
DB_USER="${DB_USER:-postgres}"

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"

echo "🗄️  Đang sao lưu database '${DB_NAME}' từ container '${CONTAINER_NAME}'..."
docker exec "$CONTAINER_NAME" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists | gzip > "$BACKUP_FILE"

if [ ! -s "$BACKUP_FILE" ] || ! gzip -t "$BACKUP_FILE"; then
  echo "❌ File backup không hợp lệ hoặc bị rỗng: ${BACKUP_FILE}"
  rm -f "$BACKUP_FILE"
  exit 1
fi

echo "✅ Đã tạo backup thành công: ${BACKUP_FILE} ($(du -h "$BACKUP_FILE" | cut -f1))"

# Dọn các bản backup cũ hơn RETENTION_DAYS ngày
find "$BACKUP_DIR" -type f -name "${DB_NAME}_*.sql.gz" -mtime +"$RETENTION_DAYS" -delete
echo "🧹 Đã dọn dẹp các bản backup cũ hơn ${RETENTION_DAYS} ngày."
