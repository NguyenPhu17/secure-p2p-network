/**
 * RoutingTable - Bảng định tuyến Kademlia hoàn chỉnh
 * Quản lý 160 K-Buckets tương ứng với không gian địa chỉ 160-bit SHA-1.
 * Cung cấp giải thuật tìm K-Nodes gần nhất (Closest Nodes Lookup) dựa trên khoảng cách XOR.
 */

import { DhtContact, getBucketIndex, xorDistance } from "./dht-types.js";
import { KBucket, BucketUpdateResult } from "./k-bucket.js";

export class RoutingTable {
  private buckets: KBucket[] = [];
  public readonly localNodeId: string;
  public readonly kSize: number;

  constructor(localNodeId: string, kSize: number = 8) {
    this.localNodeId = localNodeId.toLowerCase();
    this.kSize = kSize;

    // Khởi tạo 160 buckets cho không gian 160-bit
    for (let i = 0; i < 160; i++) {
      this.buckets.push(new KBucket(this.kSize));
    }
  }

  /**
   * Thêm hoặc cập nhật contact vào bảng định tuyến
   */
  public addOrUpdate(contact: DhtContact): BucketUpdateResult | null {
    // Không bao giờ lưu chính mình vào routing table
    if (contact.nodeId.toLowerCase() === this.localNodeId) {
      return null;
    }

    const bucketIdx = getBucketIndex(this.localNodeId, contact.nodeId);
    return this.buckets[bucketIdx].addOrUpdate(contact);
  }

  /**
   * Xóa một contact khỏi bảng định tuyến khi phát hiện offline
   */
  public remove(nodeId: string): boolean {
    const bucketIdx = getBucketIndex(this.localNodeId, nodeId);
    return this.buckets[bucketIdx].remove(nodeId);
  }

  /**
   * Lấy thông tin contact theo nodeId
   */
  public get(nodeId: string): DhtContact | undefined {
    const bucketIdx = getBucketIndex(this.localNodeId, nodeId);
    return this.buckets[bucketIdx].get(nodeId);
  }

  /**
   * Tìm K contacts gần nhất với một targetId bất kỳ theo khoảng cách XOR
   */
  public getClosestNodes(targetId: string, count: number = this.kSize): DhtContact[] {
    const all = this.getAll();
    const targetNorm = targetId.toLowerCase();

    // Sắp xếp các node theo khoảng cách XOR tăng dần đến targetId
    all.sort((a, b) => {
      const distA = xorDistance(a.nodeId, targetNorm);
      const distB = xorDistance(b.nodeId, targetNorm);
      if (distA < distB) return -1;
      if (distA > distB) return 1;
      return 0;
    });

    return all.slice(0, count);
  }

  /**
   * Lấy toàn bộ contacts đang có trong tất cả 160 buckets
   */
  public getAll(): DhtContact[] {
    const result: DhtContact[] = [];
    for (const bucket of this.buckets) {
      result.push(...bucket.getAll());
    }
    return result;
  }

  /**
   * Tổng số node đang quản lý trong bảng định tuyến
   */
  public size(): number {
    let total = 0;
    for (const b of this.buckets) {
      total += b.size();
    }
    return total;
  }

  /**
   * Lấy bucket tại vị trí cụ thể (0..159)
   */
  public getBucket(index: number): KBucket {
    return this.buckets[index];
  }
}

