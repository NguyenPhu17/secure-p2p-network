/**
 * Quản lý khởi tạo Database SQLite và Migration cho từng Peer
 * Sử dụng node:sqlite chuẩn có sẵn trong Node.js, không cần compile C++
 * Tối ưu RAM: Bật WAL mode, giới hạn cache_size ~2MB.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function initDatabase(dbPath: string): DatabaseSync {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // 1. Tối ưu hóa hiệu năng & Tiết kiệm RAM
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA cache_size = -2000;"); // Giới hạn cache ~2MB RAM cho mỗi DB peer

  // 2. Bảng quản lý phiên bản migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const versionQuery = db.prepare("SELECT MAX(version) as current_version FROM schema_version");
  const row = versionQuery.get() as { current_version: number | null } | undefined;
  const currentVersion = row?.current_version || 0;

  if (currentVersion < 1) {
    runMigrationV1(db);
  }

  return db;
}

function runMigrationV1(db: DatabaseSync): void {
  db.exec(`
    -- Danh sách các peer đã từng liên lạc
    CREATE TABLE IF NOT EXISTS peers (
      peer_name TEXT PRIMARY KEY,
      last_ip TEXT,
      last_port INTEGER,
      last_seen INTEGER NOT NULL
    );

    -- Cuộc hội thoại giữa ta và peer đối phương
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      peer_name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL
    );

    -- Lưu trữ tin nhắn (Chat & File thông báo)
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
      seq INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'delivered', 'failed')),
      type TEXT NOT NULL CHECK(type IN ('chat', 'file')),
      file_id TEXT,
      created_at INTEGER NOT NULL,
      -- TODO(SECURITY): Cột lưu nonce và chữ ký phục vụ kiểm tra toàn vẹn at-rest
      nonce TEXT,
      mac_or_signature TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    -- Quản lý metadata file gửi và nhận
    CREATE TABLE IF NOT EXISTS files (
      file_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('transferring', 'completed', 'failed')),
      local_path TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    -- Chỉ mục tối ưu tải lịch sử tin nhắn phân trang cuộn lên
    CREATE INDEX IF NOT EXISTS idx_messages_conv_time 
      ON messages(conversation_id, timestamp DESC, seq DESC);

    INSERT INTO schema_version (version, applied_at) VALUES (1, ${Date.now()});
  `);
}

