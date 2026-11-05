/**
 * MessageStore - Lớp trừu tượng duy nhất để truy cập Cơ sở Dữ liệu SQLite
 * Đóng gói toàn bộ câu lệnh SQL, chống trùng lặp message_id, xử lý hàng đợi offline và lịch sử tin nhắn.
 *
 * TODO(SECURITY): Trong Giai đoạn 2, thành viên bảo mật có thể:
 * 1. Bổ sung mã hóa at-rest cho cột `body` trước khi INSERT (dùng Secret Key cục bộ).
 * 2. Lưu trữ và xác thực trường `nonce` và `mac_or_signature` khi đọc/ghi tin nhắn.
 */

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = initDatabase(dbPath);
  }

  /**
   * Tạo hoặc lấy ID cuộc trò chuyện với một peer đối tác
   */
  public getOrCreateConversation(peerName: string): string {
    const convId = `conv_${peerName}`;
    const now = Date.now();

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO conversations (id, peer_name, created_at, last_message_at)
      VALUES (?, ?, ?, ?)
    `);
    insertStmt.run(convId, peerName, now, now);

    return convId;
  }

  /**
   * Lưu tin nhắn vào DB.
   * Chống trùng lặp (Deduplication): Nếu message_id đã tồn tại -> Bỏ qua và trả về isDuplicate = true.
   */
  public saveMessage(msg: MessageRecord): { isDuplicate: boolean } {
    // 1. Kiểm tra trùng lặp message_id
    const checkStmt = this.db.prepare("SELECT message_id FROM messages WHERE message_id = ?");
    const existing = checkStmt.get(msg.message_id);
    if (existing) {
      return { isDuplicate: true };
    }

    // 2. Đảm bảo conversation tồn tại
    const partnerName = msg.direction === "out" ? msg.receiver : msg.sender;
    const convId = this.getOrCreateConversation(partnerName);

    // 3. TODO(SECURITY): Nếu muốn mã hóa at-rest, thực hiện mã hóa msg.body tại đây trước khi lưu
    const insertStmt = this.db.prepare(`
      INSERT INTO messages (
        message_id, conversation_id, sender, receiver, direction,
        seq, timestamp, body, status, type, file_id, created_at, nonce, mac_or_signature,
        route, relayed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      msg.message_id,
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
      msg.relayed_by || null
    );

    // 4. Cập nhật last_message_at của cuộc hội thoại
    const updateConvStmt = this.db.prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?");
    updateConvStmt.run(msg.timestamp, convId);

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
    return {
      ...row,
      route: Array.isArray(route) ? route : null
    };
  }

  /**
   * Tìm kiếm 1 message theo ID
   */
  public getMessage(messageId: string): MessageRecord | null {
    const stmt = this.db.prepare("SELECT * FROM messages WHERE message_id = ?");
    const row = stmt.get(messageId) as any;
    return row ? this.mapRowToRecord(row) : null;
  }

  /**
   * Cập nhật trạng thái tin nhắn (pending -> sent -> delivered)
   */
  public updateMessageStatus(
    messageId: string,
    status: MessageRecord["status"],
    route?: string[] | null,
    relayedBy?: string | null
  ): void {
    if (route !== undefined || relayedBy !== undefined) {
      const stmt = this.db.prepare(
        "UPDATE messages SET status = ?, route = COALESCE(?, route), relayed_by = COALESCE(?, relayed_by) WHERE message_id = ?"
      );
      stmt.run(status, route ? JSON.stringify(route) : null, relayedBy || null, messageId);
    } else {
      const stmt = this.db.prepare("UPDATE messages SET status = ? WHERE message_id = ?");
      stmt.run(status, messageId);
    }
  }

  /**
   * Lấy các tin nhắn chưa gửi được (status = 'pending') của một peer để tự động gửi lại
   */
  public getPendingMessages(peerName: string): MessageRecord[] {
    const convId = `conv_${peerName}`;
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = ? AND direction = 'out' AND status = 'pending'
      ORDER BY timestamp ASC, seq ASC
    `);
    const rows = stmt.all(convId) as any[];
    return rows.map((r) => this.mapRowToRecord(r));
  }

  /**
   * Lấy số Sequence number kế tiếp cho tin nhắn gửi tới peer đối phương
   */
  public getNextSeq(peerName: string): number {
    const convId = `conv_${peerName}`;
    const stmt = this.db.prepare(`
      SELECT MAX(seq) as maxSeq FROM messages WHERE conversation_id = ? AND direction = 'out'
    `);
    const row = stmt.get(convId) as any;
    return (row?.maxSeq || 0) + 1;
  }

  /**
   * Lấy lịch sử tin nhắn phân trang (Tối ưu RAM: mặc định 50 tin)
   * Phục vụ tính năng cuộn lên đầu để tải thêm tin cũ
   */
  public getHistory(peerName: string, limit = 50, beforeTimestamp?: number): MessageRecord[] {
    const convId = `conv_${peerName}`;
    let stmt;
    let rows: any[];

    if (beforeTimestamp) {
      stmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ? AND timestamp < ?
        ORDER BY timestamp DESC, seq DESC
        LIMIT ?
      `);
      rows = stmt.all(convId, beforeTimestamp, limit);
    } else {
      stmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ?
        ORDER BY timestamp DESC, seq DESC
        LIMIT ?
      `);
      rows = stmt.all(convId, limit);
    }

    // Đảo ngược lại theo thứ tự thời gian tăng dần để UI render từ trên xuống dưới
    return rows.reverse().map((r) => this.mapRowToRecord(r));
  }

  /**
   * Xóa toàn bộ lịch sử một cuộc hội thoại
   */
  public deleteConversation(peerName: string): void {
    const convId = `conv_${peerName}`;
    const delFiles = this.db.prepare("DELETE FROM files WHERE conversation_id = ?");
    delFiles.run(convId);
    const delMsgs = this.db.prepare("DELETE FROM messages WHERE conversation_id = ?");
    delMsgs.run(convId);
    const delConv = this.db.prepare("DELETE FROM conversations WHERE id = ?");
    delConv.run(convId);
  }

  /**
   * Lưu / Cập nhật thông tin Peer trong DB
   */
  public upsertPeer(peer: PeerInfo): void {
    const stmt = this.db.prepare(`
      INSERT INTO peers (peer_name, last_ip, last_port, last_seen, node_id, public_key)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_name) DO UPDATE SET
        last_ip = excluded.last_ip,
        last_port = excluded.last_port,
        last_seen = excluded.last_seen,
        node_id = COALESCE(excluded.node_id, peers.node_id),
        public_key = COALESCE(excluded.public_key, peers.public_key)
    `);
    stmt.run(
      peer.displayName,
      peer.ip,
      peer.tcpPort,
      peer.lastSeen || Date.now(),
      peer.nodeId || null,
      peer.publicKey || null
    );
  }

  public getKnownPeers(): PeerInfo[] {
    const stmt = this.db.prepare("SELECT peer_name as displayName, last_ip as ip, last_port as tcpPort, last_seen as lastSeen, node_id as nodeId, public_key as publicKey FROM peers");
    return stmt.all() as any[];
  }

  public getPeer(peerName: string): PeerInfo | null {
    const stmt = this.db.prepare("SELECT peer_name as displayName, last_ip as ip, last_port as tcpPort, last_seen as lastSeen, node_id as nodeId, public_key as publicKey FROM peers WHERE peer_name = ?");
    const row = stmt.get(peerName) as any;
    return row || null;
  }

  /**
   * Lấy hoặc tạo mới danh tính mật mã học (Ed25519 KeyPair & Node ID 160-bit SHA-1)
   * Chuẩn P2P: Node ID = SHA1(PublicKey) thay vì SHA1(displayName)
   * Giúp bảo toàn danh tính qua các lần khởi động và ngăn chặn xung đột định danh trong K-bucket.
   */
  public getOrGenerateIdentity(displayName: string): { publicKey: string; privateKey: string; nodeId: string } {
    try {
      const query = this.db.prepare("SELECT public_key, private_key, node_id FROM node_identity LIMIT 1");
      const row = query.get() as { public_key: string; private_key: string; node_id: string } | undefined;

      if (row && row.public_key && row.private_key && row.node_id) {
        return {
          publicKey: row.public_key,
          privateKey: row.private_key,
          nodeId: row.node_id
        };
      }
    } catch {
      // Bảng có thể chưa tạo nếu DB in-memory đặc biệt
    }

    // Tạo mới cặp khóa mật mã học Ed25519
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const nodeId = generateNodeIdFromPublicKey(pubPem);

    try {
      const insert = this.db.prepare(`
        INSERT INTO node_identity (id, display_name, public_key, private_key, node_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insert.run(crypto.randomUUID(), displayName, pubPem, privPem, nodeId, Date.now());
    } catch {}

    return { publicKey: pubPem, privateKey: privPem, nodeId };
  }

  /**
   * Quản lý Metadata File
   */
  public saveFileMeta(file: FileRecord): void {
    const partnerName = file.conversation_id.replace(/^conv_/, "");
    this.getOrCreateConversation(partnerName);

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (
        file_id, conversation_id, file_name, size, hash, status, local_path, direction, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      file.file_id,
      file.conversation_id,
      file.file_name,
      file.size,
      file.hash,
      file.status,
      file.local_path,
      file.direction,
      file.created_at
    );
  }

  public updateFileStatus(fileId: string, status: FileRecord["status"]): void {
    const stmt = this.db.prepare("UPDATE files SET status = ? WHERE file_id = ?");
    stmt.run(status, fileId);
  }

  public getFileMeta(fileId: string): FileRecord | null {
    const stmt = this.db.prepare("SELECT * FROM files WHERE file_id = ?");
    const row = stmt.get(fileId) as any;
    return row ? (row as FileRecord) : null;
  }

  /**
   * ============================================================================
   * PHẦN BỀN VỮNG DỮ LIỆU DHT KADEMLIA (DHT PERSISTENT STORAGE)
   * ============================================================================
   */

  /**
   * Lưu trữ hoặc cập nhật một cặp Key-Value DHT vào SQLite
   */
  public saveDhtRecord(
    key: string,
    value: any,
    expiresAt: number,
    publisher: string,
    isLocalPublished = false
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO dht_storage (key, value, expires_at, publisher, is_local_published, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        expires_at = excluded.expires_at,
        publisher = excluded.publisher,
        is_local_published = excluded.is_local_published,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      key,
      JSON.stringify(value),
      expiresAt,
      publisher,
      isLocalPublished ? 1 : 0,
      Date.now()
    );
  }

  /**
   * Truy vấn một bản ghi DHT theo Key
   */
  public getDhtRecord(key: string): StoredValue | null {
    const stmt = this.db.prepare("SELECT * FROM dht_storage WHERE key = ?");
    const row = stmt.get(key) as any;
    if (!row) return null;
    try {
      return {
        value: JSON.parse(row.value),
        expiresAt: row.expires_at,
        publisher: row.publisher,
        isLocalPublished: row.is_local_published === 1
      };
    } catch {
      return null;
    }
  }

  /**
   * Xóa một bản ghi DHT theo Key
   */
  public deleteDhtRecord(key: string): void {
    const stmt = this.db.prepare("DELETE FROM dht_storage WHERE key = ?");
    stmt.run(key);
  }

  /**
   * Lấy tất cả các bản ghi DHT chưa hết hạn để nạp vào RAM khi khởi động node
   */
  public getAllUnexpiredDhtRecords(now: number = Date.now()): Map<string, StoredValue> {
    const stmt = this.db.prepare("SELECT * FROM dht_storage WHERE expires_at > ?");
    const rows = stmt.all(now) as any[];
    const map = new Map<string, StoredValue>();
    for (const r of rows) {
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
  public getLocalPublishedDhtRecords(
    now: number = Date.now()
  ): Array<{ key: string; value: any; expiresAt: number; publisher: string }> {
    const stmt = this.db.prepare(
      "SELECT * FROM dht_storage WHERE is_local_published = 1 AND expires_at > ?"
    );
    const rows = stmt.all(now) as any[];
    return rows.map((r) => ({
      key: r.key,
      value: JSON.parse(r.value),
      expiresAt: r.expires_at,
      publisher: r.publisher
    }));
  }

  /**
   * Dọn dẹp các bản ghi DHT đã hết hạn
   */
  public cleanupExpiredDhtRecords(now: number = Date.now()): void {
    const stmt = this.db.prepare("DELETE FROM dht_storage WHERE expires_at <= ?");
    stmt.run(now);
  }

  public close(): void {
    this.db.close();
  }
}
