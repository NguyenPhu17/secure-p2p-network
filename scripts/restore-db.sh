#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Cách dùng: $0 <duong-dan-file-backup.sql.gz> [--yes]"
  exit 1
fi

BACKUP_FILE="$1"
AUTO_CONFIRM="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONTAINER_NAME="${POSTGRES_CONTAINER:-p2p-postgres}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ Không tìm thấy file backup: ${BACKUP_FILE}"
  exit 1
fi

if ! gzip -t "$BACKUP_FILE"; then
  echo "❌ File backup bị hỏng (lỗi gzip): ${BACKUP_FILE}"
  exit 1
fi

if [ -f "${PROJECT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_DIR}/.env"
  set +a
fi

DB_NAME="${DB_NAME:-p2p_network}"
DB_USER="${DB_USER:-postgres}"

if [ "$AUTO_CONFIRM" != "--yes" ]; then
  read -r -p "⚠️  Khôi phục sẽ ghi đè dữ liệu trong '${DB_NAME}'. Tiếp tục? [y/N]: " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Đã hủy khôi phục."
    exit 0
  fi
fi

echo "♻️  Đang khôi phục '${DB_NAME}' từ '${BACKUP_FILE}'..."
gunzip -c "$BACKUP_FILE" | docker exec -i "$CONTAINER_NAME" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME"
echo "✅ Khôi phục database '${DB_NAME}' thành công!"
