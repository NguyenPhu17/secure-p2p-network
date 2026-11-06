/**
 * DHT Types & Utilities (Kademlia 160-bit Metric Space)
 */

import crypto from "node:crypto";
import { PeerInfo } from "../../common/protocol.js";

export interface DhtContact extends PeerInfo {
  nodeId: string;
  failedPings: number;
}

export interface StoredValue {
  value: any;
  expiresAt: number;
  publisher: string;
  isLocalPublished?: boolean;
  lamport_clock?: number;
  version?: number;
}

export interface MailboxMessage {
  message_id: string;
  sender: string;
  receiver: string;
  timestamp: number;
  lamport_clock?: number;
  vector_clock?: Record<string, number>;
  body: string;
  seq: number;
  nonce?: string | null;
  mac_or_signature?: string | null;
}

export interface IDhtPersistentStore {
  saveDhtRecord(
    key: string,
    value: any,
    expiresAt: number,
    publisher: string,
    isLocalPublished?: boolean,
    lamport_clock?: number,
    version?: number
  ): void;
  getDhtRecord(key: string): StoredValue | null;
  deleteDhtRecord(key: string): void;
  getAllUnexpiredDhtRecords(now?: number): Map<string, StoredValue>;
  getLocalPublishedDhtRecords(now?: number): Array<{ key: string; value: any; expiresAt: number; publisher: string }>;
  cleanupExpiredDhtRecords(now?: number): void;
}

/**
 * Tạo DHT key 160-bit cho Distributed Mailbox của một peer
 * Đảm bảo key nằm trong không gian metric 160-bit Kademlia (SHA-1)
 */
export function getMailboxKey(recipientName: string): string {
  return generateNodeId(`mailbox:${recipientName.toLowerCase()}`);
}

/**
 * Tạo Node ID 160-bit chuẩn Kademlia từ Public Key mật mã học (SHA-1)
 * Chuẩn P2P: Node ID = SHA1(PublicKey) thay vì SHA1(displayName)
 * để loại bỏ xung đột định danh khi nhiều node trùng tên hiển thị.
 * Trả về 40 ký tự hex tương đương 160 bits.
 */
export function generateNodeIdFromPublicKey(publicKey: string | Buffer): string {
  return crypto.createHash("sha1").update(publicKey).digest("hex");
}

/**
 * Tạo Node ID / Key 160-bit chuẩn Kademlia từ chuỗi định danh (SHA-1)
 * Trả về 40 ký tự hex tương đương 160 bits.
 */
export function generateNodeId(name: string): string {
  return crypto.createHash("sha1").update(name).digest("hex");
}

/**
 * Tính khoảng cách XOR giữa 2 Node ID 160-bit
 * d(x, y) = x ^ y
 */
export function xorDistance(idA: string, idB: string): bigint {
  const normA = idA.toLowerCase().padStart(40, "0");
  const normB = idB.toLowerCase().padStart(40, "0");
  return BigInt("0x" + normA) ^ BigInt("0x" + normB);
}

/**
 * Xác định K-Bucket index (0..159) dựa trên khoảng cách XOR giữa 2 ID
 * Bucket i chứa các node có bit khác biệt đầu tiên tại vị trí i.
 */
export function getBucketIndex(localId: string, targetId: string): number {
  const dist = xorDistance(localId, targetId);
  if (dist === 0n) return 0;
  const bitLength = dist.toString(2).length; // 1 đến 160
  return Math.max(0, Math.min(159, bitLength - 1));
}

