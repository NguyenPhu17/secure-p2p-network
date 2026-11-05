/**
 * DHT Types & Utilities (Kademlia 160-bit Metric Space)
 */

import crypto from "node:crypto";
import { PeerInfo } from "../../common/protocol.js";

export interface DhtContact extends PeerInfo {
  nodeId: string;
  failedPings: number;
}

/**
 * Tạo Node ID 160-bit chuẩn Kademlia từ chuỗi định danh (SHA-1)
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

