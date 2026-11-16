/**
 * MessageStore - Lớp trừu tượng duy nhất để truy cập Cơ sở Dữ liệu PostgreSQL
 * Đóng gói toàn bộ câu lệnh SQL, chống trùng lặp message_id, xử lý hàng đợi offline và lịch sử tin nhắn.
 * Hỗ trợ multi-tenant: cột node_owner phân biệt dữ liệu giữa các peer node dùng chung 1 DB.
 *
 * TODO(SECURITY): Trong Giai đoạn 2, thành viên bảo mật có thể:
 * 1. Bổ sung mã hóa at-rest cho cột `body` trước khi INSERT (dùng Secret Key cục bộ).
 * 2. Lưu trữ và xác thực trường `nonce` và `mac_or_signature` khi đọc/ghi tin nhắn.
 */

import crypto from "node:crypto";
import { Pool } from "pg";
import { initDatabase } from "./migrations.js";
import { PeerInfo } from "../../common/protocol.js";
import { IDhtPersistentStore, StoredValue, generateNodeIdFromPublicKey } from "../dht/dht-types.js";

export interface MessageRecord {
  message_id: string;
  conversation_id: string;
  sender: string;
  receiver: string;
  direction: "in" | "out";
  seq: number;
  timestamp: number;
  lamport_clock?: number;        // Leslie Lamport Logical Clock (1978)
  vector_clock?: Record<string, number> | null; // Vector Clock theo dõi quan hệ Happened-Before
  body: string;
  status: "pending" | "sent" | "delivered" | "failed";
  type: "chat" | "file";
  file_id?: string | null;
  created_at: number;
  nonce?: string | null;
  mac_or_signature?: string | null;
  route?: string[] | null;       // Tuyến đường Mesh relay (VD: ["Alice", "Charlie", "Bob"])
  relayed_by?: string | null;    // Peer trung gian chuyển tiếp (VD: "Charlie")
}

export interface FileRecord {
  file_id: string;
  conversation_id: string;
  file_name: string;
  size: number;
  hash: string;
  status: "transferring" | "completed" | "failed";
  local_path: string;
  direction: "in" | "out";
  created_at: number;
}

export class MessageStore implements IDhtPersistentStore {
  private pool: Pool;
  private nodeOwner: string;

  private constructor(pool: Pool, nodeOwner: string) {
    this.pool = pool;
    this.nodeOwner = nodeOwner;
  }

  /**
   * Factory method tạo MessageStore (thay cho constructor vì cần async init)
   */
  public static async create(pool: Pool, nodeOwner: string): Promise<MessageStore> {
    const store = new MessageStore(pool, nodeOwner);
    await initDatabase(pool);
    return store;
  }

  /**
   * Tạo hoặc lấy ID cuộc trò chuyện với một peer đối tác
   */
  public async getOrCreateConversation(peerName: string): Promise<string> {
    const convId = `conv_${peerName}`;
    const now = Date.now();

    await this.pool.query(
      `INSERT INTO conversations (id, node_owner, peer_name, created_at, last_message_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id, node_owner) DO NOTHING`,
      [convId, this.nodeOwner, peerName, now, now]
    );

    return convId;
  }

  /**
   * Lưu tin nhắn vào DB.
   * Chống trùng lặp (Deduplication): Nếu message_id đã tồn tại -> Bỏ qua và trả về isDuplicate = true.
   */
  public async saveMessage(msg: MessageRecord): Promise<{ isDuplicate: boolean }> {
    // 1. Kiểm tra trùng lặp message_id
    const checkResult = await this.pool.query(
      "SELECT message_id FROM messages WHERE message_id = $1 AND node_owner = $2",
      [msg.message_id, this.nodeOwner]
    );
    if (checkResult.rows.length > 0) {
      return { isDuplicate: true };
    }

    // 2. Đảm bảo conversation tồn tại
    const partnerName = msg.direction === "out" ? msg.receiver : msg.sender;
    const convId = await this.getOrCreateConversation(partnerName);

    // 3. TODO(SECURITY): Nếu muốn mã hóa at-rest, thực hiện mã hóa msg.body tại đây trước khi lưu
    await this.pool.query(
      `INSERT INTO messages (
        message_id, node_owner, conversation_id, sender, receiver, direction,
        seq, timestamp, body, status, type, file_id, created_at, nonce, mac_or_signature,
        route, relayed_by, lamport_clock, vector_clock
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        msg.message_id,
        this.nodeOwner,
        convId,
        msg.sender,
        msg.receiver,
        msg.direction,
        msg.seq,
        msg.timestamp,
        msg.body,
        msg.status,
        msg.type,
        msg.file_id || null,
        msg.created_at || Date.now(),
        msg.nonce || null,
        msg.mac_or_signature || null,
        msg.route ? JSON.stringify(msg.route) : null,
        msg.relayed_by || null,
        msg.lamport_clock || 0,
        msg.vector_clock ? JSON.stringify(msg.vector_clock) : null
      ]
    );

    // 4. Cập nhật last_message_at của cuộc hội thoại
    await this.pool.query(
      "UPDATE conversations SET last_message_at = $1 WHERE id = $2 AND node_owner = $3",
      [msg.timestamp, convId, this.nodeOwner]
    );

    return { isDuplicate: false };
  }

  private mapRowToRecord(row: any): MessageRecord {
    let route = row.route;
    if (typeof route === "string") {
      try {
        route = JSON.parse(route);
      } catch (e) {
        route = null;
      }
    }
    let vector_clock = row.vector_clock;
    if (typeof vector_clock === "string") {
      try {
        vector_clock = JSON.parse(vector_clock);
      } catch (e) {
        vector_clock = null;
      }
    }
    return {
      ...row,
      route: Array.isArray(route) ? route : null,
      lamport_clock: row.lamport_clock !== undefined && row.lamport_clock !== null ? Number(row.lamport_clock) : 0,
      vector_clock: vector_clock && typeof vector_clock === "object" ? vector_clock : null
    };
  }

  /**
   * Tìm kiếm 1 message theo ID
   */
  public async getMessage(messageId: string): Promise<MessageRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM messages WHERE message_id = $1 AND node_owner = $2",
      [messageId, this.nodeOwner]
    );
    const row = result.rows[0];
    return row ? this.mapRowToRecord(row) : null;
  }

  /**
   * Cập nhật trạng thái tin nhắn (pending -> sent -> delivered)
   */
  public async updateMessageStatus(
    messageId: string,
    status: MessageRecord["status"],
    route?: string[] | null,
    relayedBy?: string | null
  ): Promise<void> {
    if (route !== undefined || relayedBy !== undefined) {
      await this.pool.query(
        `UPDATE messages SET status = $1, route = COALESCE($2, route), relayed_by = COALESCE($3, relayed_by)
         WHERE message_id = $4 AND node_owner = $5`,
        [status, route ? JSON.stringify(route) : null, relayedBy || null, messageId, this.nodeOwner]
      );
    } else {
      await this.pool.query(
        "UPDATE messages SET status = $1 WHERE message_id = $2 AND node_owner = $3",
        [status, messageId, this.nodeOwner]
      );
    }
  }

  /**
   * Lấy các tin nhắn chưa gửi được (status = 'pending') của một peer để tự động gửi lại
   */
  public async getPendingMessages(peerName: string): Promise<MessageRecord[]> {
    const convId = `conv_${peerName}`;
    const result = await this.pool.query(
      `SELECT * FROM messages
       WHERE conversation_id = $1 AND node_owner = $2 AND direction = 'out' AND status = 'pending'
       ORDER BY lamport_clock ASC, seq ASC, timestamp ASC`,
      [convId, this.nodeOwner]
    );
    return result.rows.map((r: any) => this.mapRowToRecord(r));
  }

  /**
   * Lấy số Sequence number kế tiếp cho tin nhắn gửi tới peer đối phương
   */
  public async getNextSeq(peerName: string): Promise<number> {
    const convId = `conv_${peerName}`;
    const result = await this.pool.query(
      `SELECT MAX(seq) as "maxSeq" FROM messages WHERE conversation_id = $1 AND node_owner = $2 AND direction = 'out'`,
      [convId, this.nodeOwner]
    );
    const row = result.rows[0];
    return (row?.maxSeq || 0) + 1;
  }

  /**
   * Lấy giá trị Lamport Clock lớn nhất từng được lưu trong DB
   * Phục vụ khôi phục trạng thái đồng hồ logic khi node khởi động lại
   */
  public async getMaxLamportClock(): Promise<number> {
    const result = await this.pool.query(
      `SELECT MAX(lamport_clock) as "maxClock" FROM messages WHERE node_owner = $1`,
      [this.nodeOwner]
    );
    const row = result.rows[0];
    return row && row.maxClock ? Number(row.maxClock) : 0;
  }

  /**
   * Lưu giá trị Lamport Clock hiện tại vào bảng node_state
   */
  public async saveLamportClock(clock: number): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO node_state (key, node_owner, value, updated_at)
         VALUES ('lamport_clock', $1, $2, $3)
         ON CONFLICT(key, node_owner) DO UPDATE SET
           value = EXCLUDED.value,
           updated_at = EXCLUDED.updated_at`,
        [this.nodeOwner, String(clock), Date.now()]
      );
    } catch {}
  }

  /**
   * Lấy giá trị Lamport Clock đã lưu (kết hợp node_state và MAX messages)
   */
  public async getSavedLamportClock(): Promise<number> {
    let fromState = 0;
    try {
      const result = await this.pool.query(
        "SELECT value FROM node_state WHERE key = 'lamport_clock' AND node_owner = $1",
        [this.nodeOwner]
      );
      const row = result.rows[0];
      if (row && row.value) {
        fromState = Number(row.value) || 0;
      }
    } catch {}
    const fromMessages = await this.getMaxLamportClock();
    return Math.max(fromState, fromMessages);
  }

  /**
   * Lấy lịch sử tin nhắn phân trang (Tối ưu RAM: mặc định 50 tin)
   * Sắp xếp theo Lamport Total Order (Thứ tự nhân quả):
   * ORDER BY lamport_clock DESC, seq DESC, timestamp DESC
   */
  public async getHistory(peerName: string, limit = 50, beforeClockOrTimestamp?: number): Promise<MessageRecord[]> {
    const convId = `conv_${peerName}`;
    let result;

    if (beforeClockOrTimestamp) {
      // Nếu tham số truyền vào là timestamp lớn (ví dụ > 1,000,000,000,000 ms của Date.now())
      if (beforeClockOrTimestamp > 1000000000000) {
        result = await this.pool.query(
          `SELECT * FROM messages
           WHERE conversation_id = $1 AND node_owner = $2 AND timestamp < $3
           ORDER BY lamport_clock DESC, seq DESC, timestamp DESC
           LIMIT $4`,
          [convId, this.nodeOwner, beforeClockOrTimestamp, limit]
        );
      } else {
        // Tham số là Lamport Clock
        result = await this.pool.query(
          `SELECT * FROM messages
           WHERE conversation_id = $1 AND node_owner = $2 AND lamport_clock < $3
           ORDER BY lamport_clock DESC, seq DESC, timestamp DESC
           LIMIT $4`,
          [convId, this.nodeOwner, beforeClockOrTimestamp, limit]
        );
      }
    } else {
      result = await this.pool.query(
        `SELECT * FROM messages
         WHERE conversation_id = $1 AND node_owner = $2
         ORDER BY lamport_clock DESC, seq DESC, timestamp DESC
         LIMIT $3`,
        [convId, this.nodeOwner, limit]
      );
    }

    // Đảo ngược lại theo thứ tự thời gian tăng dần để UI render từ trên xuống dưới
    return result.rows.reverse().map((r: any) => this.mapRowToRecord(r));
  }

  /**
   * Xóa toàn bộ lịch sử một cuộc hội thoại
   */
  public async deleteConversation(peerName: string): Promise<void> {
    const convId = `conv_${peerName}`;
    await this.pool.query(
      "DELETE FROM files WHERE conversation_id = $1 AND node_owner = $2",
      [convId, this.nodeOwner]
    );
    await this.pool.query(
      "DELETE FROM messages WHERE conversation_id = $1 AND node_owner = $2",
      [convId, this.nodeOwner]
    );
    await this.pool.query(
      "DELETE FROM conversations WHERE id = $1 AND node_owner = $2",
      [convId, this.nodeOwner]
    );
  }

  /**
   * Lưu / Cập nhật thông tin Peer trong DB
   */
  public async upsertPeer(peer: PeerInfo): Promise<void> {
    await this.pool.query(
      `INSERT INTO peers (peer_name, node_owner, last_ip, last_port, last_seen, node_id, public_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(peer_name, node_owner) DO UPDATE SET
         last_ip = EXCLUDED.last_ip,
         last_port = EXCLUDED.last_port,
         last_seen = EXCLUDED.last_seen,
         node_id = COALESCE(EXCLUDED.node_id, peers.node_id),
         public_key = COALESCE(EXCLUDED.public_key, peers.public_key)`,
      [
        peer.displayName,
        this.nodeOwner,
        peer.ip,
        peer.tcpPort,
        peer.lastSeen || Date.now(),
        peer.nodeId || null,
        peer.publicKey || null
      ]
    );
  }

  public async getKnownPeers(): Promise<PeerInfo[]> {
    const result = await this.pool.query(
      `SELECT peer_name as "displayName", last_ip as "ip", last_port as "tcpPort", last_seen as "lastSeen", node_id as "nodeId", public_key as "publicKey"
       FROM peers WHERE node_owner = $1`,
      [this.nodeOwner]
    );
    return result.rows;
  }

  public async getConversationPeers(): Promise<string[]> {
    const result = await this.pool.query(
      "SELECT peer_name FROM conversations WHERE node_owner = $1 ORDER BY last_message_at DESC",
      [this.nodeOwner]
    );
    return result.rows.map((r: { peer_name: string }) => r.peer_name).filter(Boolean);
  }

  public async getPeer(peerName: string): Promise<PeerInfo | null> {
    const result = await this.pool.query(
      `SELECT peer_name as "displayName", last_ip as "ip", last_port as "tcpPort", last_seen as "lastSeen", node_id as "nodeId", public_key as "publicKey"
       FROM peers WHERE peer_name = $1 AND node_owner = $2`,
      [peerName, this.nodeOwner]
    );
    const row = result.rows[0];
    return row || null;
  }

  /**
   * Lấy hoặc tạo mới danh tính mật mã học (Ed25519 KeyPair & Node ID 160-bit SHA-1)
   * Chuẩn P2P: Node ID = SHA1(PublicKey) thay vì SHA1(displayName)
   * Giúp bảo toàn danh tính qua các lần khởi động và ngăn chặn xung đột định danh trong K-bucket.
   */
  public async getOrGenerateIdentity(displayName: string): Promise<{ publicKey: string; privateKey: string; nodeId: string }> {
    try {
      const result = await this.pool.query(
        "SELECT public_key, private_key, node_id FROM node_identity WHERE node_owner = $1 LIMIT 1",
        [this.nodeOwner]
      );
      const row = result.rows[0];

      if (row && row.public_key && row.private_key && row.node_id) {
        return {
          publicKey: row.public_key,
          privateKey: row.private_key,
          nodeId: row.node_id
        };
      }
    } catch {
      // Bảng có thể chưa tạo nếu DB chưa init
    }

    // Tạo mới cặp khóa mật mã học Ed25519
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const nodeId = generateNodeIdFromPublicKey(pubPem);

    try {
      await this.pool.query(
        `INSERT INTO node_identity (id, node_owner, display_name, public_key, private_key, node_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [crypto.randomUUID(), this.nodeOwner, displayName, pubPem, privPem, nodeId, Date.now()]
      );
    } catch {}

    return { publicKey: pubPem, privateKey: privPem, nodeId };
  }

  /**
   * Quản lý Metadata File
   */
  public async saveFileMeta(file: FileRecord): Promise<void> {
    const partnerName = file.conversation_id.replace(/^conv_/, "");
    await this.getOrCreateConversation(partnerName);

    await this.pool.query(
      `INSERT INTO files (
        file_id, node_owner, conversation_id, file_name, size, hash, status, local_path, direction, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (file_id, node_owner) DO UPDATE SET
        conversation_id = EXCLUDED.conversation_id,
        file_name = EXCLUDED.file_name,
        size = EXCLUDED.size,
        hash = EXCLUDED.hash,
        status = EXCLUDED.status,
        local_path = EXCLUDED.local_path,
        direction = EXCLUDED.direction,
        created_at = EXCLUDED.created_at`,
      [
        file.file_id,
        this.nodeOwner,
        file.conversation_id,
        file.file_name,
        file.size,
        file.hash,
        file.status,
        file.local_path,
        file.direction,
        file.created_at
      ]
    );
  }

  public async updateFileStatus(fileId: string, status: FileRecord["status"]): Promise<void> {
    await this.pool.query(
      "UPDATE files SET status = $1 WHERE file_id = $2 AND node_owner = $3",
      [status, fileId, this.nodeOwner]
    );
  }

  public async getFileMeta(fileId: string): Promise<FileRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM files WHERE file_id = $1 AND node_owner = $2",
      [fileId, this.nodeOwner]
    );
    const row = result.rows[0];
    return row ? (row as FileRecord) : null;
  }

  /**
   * ============================================================================
   * PHẦN BỀN VỮNG DỮ LIỆU DHT KADEMLIA (DHT PERSISTENT STORAGE)
   * ============================================================================
   */

  /**
   * Lưu trữ hoặc cập nhật một cặp Key-Value DHT vào PostgreSQL.
   * Phân giải xung đột ghi đè dựa trên Lamport Logical Clock & Version (thay vì phụ thuộc Date.now()).
   */
  public async saveDhtRecord(
    key: string,
    value: any,
    expiresAt: number,
    publisher: string,
    isLocalPublished = false,
    lamportClock = 0,
    version = 1
  ): Promise<void> {
    // Kiểm tra bản ghi hiện có để phân giải xung đột nhân quả (Causality Conflict Resolution)
    const checkResult = await this.pool.query(
      "SELECT lamport_clock, version, publisher FROM dht_storage WHERE key = $1 AND node_owner = $2",
      [key, this.nodeOwner]
    );
    const existing = checkResult.rows[0];

    if (existing && existing.lamport_clock !== undefined && existing.lamport_clock !== null) {
      const existingClock = Number(existing.lamport_clock) || 0;
      // Nếu bản ghi đến có Lamport clock nhỏ hơn bản ghi hiện có -> Bản ghi cũ, không ghi đè
      if (lamportClock > 0 && lamportClock < existingClock) {
        return;
      }
      // Nếu Lamport clock bằng nhau, tie-breaker bằng phiên bản version hoặc định danh publisher
      if (lamportClock > 0 && lamportClock === existingClock) {
        const existingVer = Number(existing.version) || 1;
        if (version < existingVer) {
          return;
        }
        if (version === existingVer && publisher < (existing.publisher || "")) {
          return;
        }
      }
    }

    await this.pool.query(
      `INSERT INTO dht_storage (key, node_owner, value, expires_at, publisher, is_local_published, updated_at, lamport_clock, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(key, node_owner) DO UPDATE SET
         value = EXCLUDED.value,
         expires_at = EXCLUDED.expires_at,
         publisher = EXCLUDED.publisher,
         is_local_published = EXCLUDED.is_local_published,
         updated_at = EXCLUDED.updated_at,
         lamport_clock = EXCLUDED.lamport_clock,
         version = EXCLUDED.version`,
      [
        key,
        this.nodeOwner,
        JSON.stringify(value),
        expiresAt,
        publisher,
        isLocalPublished ? 1 : 0,
        Date.now(),
        lamportClock,
        version
      ]
    );
  }

  /**
   * Truy vấn một bản ghi DHT theo Key
   */
  public async getDhtRecord(key: string): Promise<StoredValue | null> {
    const result = await this.pool.query(
      "SELECT * FROM dht_storage WHERE key = $1 AND node_owner = $2",
      [key, this.nodeOwner]
    );
    const row = result.rows[0];
    if (!row) return null;
    try {
      return {
        value: JSON.parse(row.value),
        expiresAt: row.expires_at,
        publisher: row.publisher,
        isLocalPublished: row.is_local_published === 1,
        lamport_clock: row.lamport_clock !== undefined && row.lamport_clock !== null ? Number(row.lamport_clock) : 0,
        version: row.version !== undefined && row.version !== null ? Number(row.version) : 1
      };
    } catch {
      return null;
    }
  }

  /**
   * Xóa một bản ghi DHT theo Key
   */
  public async deleteDhtRecord(key: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM dht_storage WHERE key = $1 AND node_owner = $2",
      [key, this.nodeOwner]
    );
  }

  /**
   * Lấy tất cả các bản ghi DHT chưa hết hạn để nạp vào RAM khi khởi động node
   */
  public async getAllUnexpiredDhtRecords(now: number = Date.now()): Promise<Map<string, StoredValue>> {
    const result = await this.pool.query(
      "SELECT * FROM dht_storage WHERE expires_at > $1 AND node_owner = $2",
      [now, this.nodeOwner]
    );
    const map = new Map<string, StoredValue>();
    for (const r of result.rows) {
      try {
        map.set(r.key, {
          value: JSON.parse(r.value),
          expiresAt: r.expires_at,
          publisher: r.publisher,
          isLocalPublished: r.is_local_published === 1
        });
      } catch {}
    }
    return map;
  }

  /**
   * Lấy tất cả bản ghi do chính node này công bố (is_local_published = 1) để republish
   */
  public async getLocalPublishedDhtRecords(
    now: number = Date.now()
  ): Promise<Array<{ key: string; value: any; expiresAt: number; publisher: string }>> {
    const result = await this.pool.query(
      "SELECT * FROM dht_storage WHERE is_local_published = 1 AND expires_at > $1 AND node_owner = $2",
      [now, this.nodeOwner]
    );
    return result.rows.map((r: any) => ({
      key: r.key,
      value: JSON.parse(r.value),
      expiresAt: r.expires_at,
      publisher: r.publisher
    }));
  }

  /**
   * Dọn dẹp các bản ghi DHT đã hết hạn
   */
  public async cleanupExpiredDhtRecords(now: number = Date.now()): Promise<void> {
    await this.pool.query(
      "DELETE FROM dht_storage WHERE expires_at <= $1 AND node_owner = $2",
      [now, this.nodeOwner]
    );
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
