/**
 * Quản lý khởi tạo Database PostgreSQL và Migration cho hệ thống P2P
 * Sử dụng pg (node-postgres) với connection pool.
 * Hỗ trợ multi-tenant: cột node_owner phân biệt dữ liệu giữa các peer node dùng chung 1 DB.
 */

import { Pool } from "pg";

export async function initDatabase(pool: Pool): Promise<void> {
  // 1. Bảng quản lý phiên bản migration
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at BIGINT NOT NULL
    );
  `);

  const result = await pool.query("SELECT MAX(version) as current_version FROM schema_version");
  const currentVersion = result.rows[0]?.current_version || 0;

  if (currentVersion < 1) {
    await runMigrationV1(pool);
  }
  if (currentVersion < 2) {
    await runMigrationV2(pool);
  }
  if (currentVersion < 3) {
    await runMigrationV3(pool);
  }
  if (currentVersion < 4) {
    await runMigrationV4(pool);
  }
  if (currentVersion < 5) {
    await runMigrationV5(pool);
  }
  if (currentVersion < 6) {
    await runMigrationV6(pool);
  }
  if (currentVersion < 7) {
    await runMigrationV7(pool);
  }
}

async function runMigrationV1(pool: Pool): Promise<void> {
  await pool.query(`
    -- Danh sách các peer đã từng liên lạc
    CREATE TABLE IF NOT EXISTS peers (
      peer_name TEXT NOT NULL,
      node_owner TEXT NOT NULL,
      last_ip TEXT,
      last_port INTEGER,
      last_seen BIGINT NOT NULL,
      PRIMARY KEY (peer_name, node_owner)
    );

    -- Cuộc hội thoại giữa ta và peer đối phương
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT NOT NULL,
      node_owner TEXT NOT NULL,
      peer_name TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      last_message_at BIGINT NOT NULL,
      PRIMARY KEY (id, node_owner),
      UNIQUE (peer_name, node_owner)
    );

    -- Lưu trữ tin nhắn (Chat & File thông báo)
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT NOT NULL,
      node_owner TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
      seq INTEGER NOT NULL,
      timestamp BIGINT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'delivered', 'failed')),
      type TEXT NOT NULL CHECK(type IN ('chat', 'file')),
      file_id TEXT,
      created_at BIGINT NOT NULL,
      -- TODO(SECURITY): Cột lưu nonce và chữ ký phục vụ kiểm tra toàn vẹn at-rest
      nonce TEXT,
      mac_or_signature TEXT,
      -- Định tuyến đa chặng Mesh Relay
      route TEXT,
      relayed_by TEXT,
      -- Leslie Lamport Logical Clock & Vector Clock (Thứ tự sự kiện & Nhân quả phân tán)
      lamport_clock INTEGER DEFAULT 0,
      vector_clock TEXT,
      PRIMARY KEY (message_id, node_owner),
      FOREIGN KEY (conversation_id, node_owner) REFERENCES conversations(id, node_owner) ON DELETE CASCADE
    );

    -- Quản lý metadata file gửi và nhận
    CREATE TABLE IF NOT EXISTS files (
      file_id TEXT NOT NULL,
      node_owner TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      size BIGINT NOT NULL,
      hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('transferring', 'completed', 'failed')),
      local_path TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
      created_at BIGINT NOT NULL,
      PRIMARY KEY (file_id, node_owner),
      FOREIGN KEY (conversation_id, node_owner) REFERENCES conversations(id, node_owner) ON DELETE CASCADE
    );

    -- Bảng lưu trữ trạng thái node (Lamport Clock, Sequence...)
    CREATE TABLE IF NOT EXISTS node_state (
      key TEXT NOT NULL,
      node_owner TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (key, node_owner)
    );

    -- Chỉ mục tối ưu tải lịch sử tin nhắn phân trang cuộn lên
    CREATE INDEX IF NOT EXISTS idx_messages_conv_time
      ON messages(conversation_id, node_owner, timestamp DESC, seq DESC);
  `);

  await pool.query(
    "INSERT INTO schema_version (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [1, Date.now()]
  );
}

async function runMigrationV2(pool: Pool): Promise<void> {
  // Cột route và relayed_by đã được tạo trong V1 cho PostgreSQL
  // Migration V2 giữ lại để đánh dấu phiên bản
  await pool.query(
    "INSERT INTO schema_version (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [2, Date.now()]
  );
}

async function runMigrationV3(pool: Pool): Promise<void> {
  await pool.query(`
    -- Bảng lưu trữ cặp Key-Value của DHT Kademlia bền vững (Persistence)
    CREATE TABLE IF NOT EXISTS dht_storage (
      key TEXT NOT NULL,
      node_owner TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      publisher TEXT NOT NULL,
      is_local_published INTEGER NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (key, node_owner)
    );
    CREATE INDEX IF NOT EXISTS idx_dht_expires ON dht_storage(expires_at);
  `);

  await pool.query(
    "INSERT INTO schema_version (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [3, Date.now()]
  );
}

async function runMigrationV4(pool: Pool): Promise<void> {
  await pool.query(`
    -- Bảng lưu trữ danh tính mật mã học (Ed25519 KeyPair và Node ID SHA-1)
    CREATE TABLE IF NOT EXISTS node_identity (
      id TEXT NOT NULL,
      node_owner TEXT NOT NULL,
      display_name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (id, node_owner)
    );
  `);

  // Thêm cột node_id và public_key cho peers nếu chưa có
  // PostgreSQL: dùng DO block để tránh lỗi nếu cột đã tồn tại
  await pool.query(`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE peers ADD COLUMN node_id TEXT;
      EXCEPTION WHEN duplicate_column THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE peers ADD COLUMN public_key TEXT;
      EXCEPTION WHEN duplicate_column THEN
        NULL;
      END;
    END$$;
  `);

  await pool.query(
    "INSERT INTO schema_version (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [4, Date.now()]
  );
}

async function runMigrationV5(pool: Pool): Promise<void> {
  // Thêm cột Lamport Clock và Vector Clock cho messages nếu đã tạo DB từ trước V5
  // Thêm cột lamport_clock và version cho dht_storage
  await pool.query(`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE messages ADD COLUMN lamport_clock INTEGER DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE messages ADD COLUMN vector_clock TEXT;
      EXCEPTION WHEN duplicate_column THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE dht_storage ADD COLUMN lamport_clock INTEGER DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE dht_storage ADD COLUMN version INTEGER DEFAULT 1;
      EXCEPTION WHEN duplicate_column THEN
        NULL;
      END;
    END$$;
  `);

  // Tạo chỉ mục tối ưu hóa truy vấn lịch sử theo thứ tự nhân quả Lamport
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_causal
      ON messages(conversation_id, node_owner, lamport_clock DESC, seq DESC);
  `);

  await pool.query(
    "INSERT INTO schema_version (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [5, Date.now()]
  );
}

async function runMigrationV6(pool: Pool): Promise<void> {
  // Bảng tài khoản người dùng cho hệ thống
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      display_name TEXT NOT NULL,
      node_port INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  `);

  // Không tự động tạo tài khoản mặc định, để hệ thống phân bổ người dùng đăng ký mới
  const defaultAccounts: Array<{ username: string; displayName: string; port: number }> = [];

  const crypto = await import("node:crypto");
  for (const acc of defaultAccounts) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync("123456", salt, 64).toString("hex");
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, username, password_hash, password_salt, display_name, node_port, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (username) DO NOTHING`,
      [id, acc.username, hash, salt, acc.displayName, acc.port, Date.now()]
    );
  }

  await pool.query(
    "INSERT INTO schema_version (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [6, Date.now()]
  );
}

async function runMigrationV7(pool: Pool): Promise<void> {
  // Thêm các cột phục vụ Rate Limiting & Account Lockout chống tấn công Brute-force
  await pool.query(`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE users ADD COLUMN failed_attempts INTEGER DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE users ADD COLUMN last_failed_at BIGINT DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN
        NULL;
      END;
      BEGIN
        ALTER TABLE users ADD COLUMN locked_until BIGINT DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN
        NULL;
      END;
    END$$;
  `);

  await pool.query(
    "INSERT INTO schema_version (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [7, Date.now()]
  );
}
