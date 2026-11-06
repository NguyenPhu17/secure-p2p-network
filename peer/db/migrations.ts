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
  if (currentVersion < 2) {
    runMigrationV2(db);
  }
  if (currentVersion < 3) {
    runMigrationV3(db);
  }
  if (currentVersion < 4) {
    runMigrationV4(db);
  }
  if (currentVersion < 5) {
    runMigrationV5(db);
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
      -- Định tuyến đa chặng Mesh Relay
      route TEXT,
      relayed_by TEXT,
      -- Leslie Lamport Logical Clock & Vector Clock (Thứ tự sự kiện & Nhân quả phân tán)
      lamport_clock INTEGER DEFAULT 0,
      vector_clock TEXT,
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

    -- Bảng lưu trữ trạng thái node (Lamport Clock, Sequence...)
    CREATE TABLE IF NOT EXISTS node_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Chỉ mục tối ưu tải lịch sử tin nhắn phân trang cuộn lên
    CREATE INDEX IF NOT EXISTS idx_messages_conv_time 
      ON messages(conversation_id, timestamp DESC, seq DESC);

    INSERT INTO schema_version (version, applied_at) VALUES (1, ${Date.now()});
  `);
}

function runMigrationV2(db: DatabaseSync): void {
  try {
    db.exec("ALTER TABLE messages ADD COLUMN route TEXT;");
  } catch (e) {
    // Đã tồn tại cột (trường hợp tạo mới từ V1)
  }
  try {
    db.exec("ALTER TABLE messages ADD COLUMN relayed_by TEXT;");
  } catch (e) {
    // Đã tồn tại cột
  }
  db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (2, ${Date.now()});`);
}

function runMigrationV3(db: DatabaseSync): void {
  db.exec(`
    -- Bảng lưu trữ cặp Key-Value của DHT Kademlia bền vững (Persistence)
    CREATE TABLE IF NOT EXISTS dht_storage (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      publisher TEXT NOT NULL,
      is_local_published INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dht_expires ON dht_storage(expires_at);
    INSERT INTO schema_version (version, applied_at) VALUES (3, ${Date.now()});
  `);
}

function runMigrationV4(db: DatabaseSync): void {
  db.exec(`
    -- Bảng lưu trữ danh tính mật mã học (Ed25519 KeyPair và Node ID SHA-1)
    CREATE TABLE IF NOT EXISTS node_identity (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  try {
    db.exec("ALTER TABLE peers ADD COLUMN node_id TEXT;");
  } catch (e) {
    // Đã tồn tại cột
  }
  try {
    db.exec("ALTER TABLE peers ADD COLUMN public_key TEXT;");
  } catch (e) {
    // Đã tồn tại cột
  }

  db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (4, ${Date.now()});`);
}

function runMigrationV5(db: DatabaseSync): void {
  // Thêm cột Lamport Clock và Vector Clock cho messages nếu đã tạo DB từ trước V5
  try {
    db.exec("ALTER TABLE messages ADD COLUMN lamport_clock INTEGER DEFAULT 0;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE messages ADD COLUMN vector_clock TEXT;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE dht_storage ADD COLUMN lamport_clock INTEGER DEFAULT 0;");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE dht_storage ADD COLUMN version INTEGER DEFAULT 1;");
  } catch (e) {}

  // Tạo chỉ mục tối ưu hóa truy vấn lịch sử theo thứ tự nhân quả Lamport
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_causal 
        ON messages(conversation_id, lamport_clock DESC, seq DESC);
    `);
  } catch (e) {}

  // Bảng lưu trữ trạng thái node (bao gồm Lamport Clock hiện tại)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  } catch (e) {}

  db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (5, ${Date.now()});`);
}



