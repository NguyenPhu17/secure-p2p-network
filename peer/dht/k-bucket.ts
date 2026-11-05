/**
 * KBucket - Cấu trúc lưu trữ K-Bucket trong bảng định tuyến Kademlia
 * Mỗi bucket lưu tối đa K contacts (mặc định K = 8 hoặc 20), sắp xếp theo thứ tự LRU -> MRU.
 */

import { DhtContact } from "./dht-types.js";

export type BucketUpdateResult =
  | { status: "ADDED"; contact: DhtContact }
  | { status: "UPDATED"; contact: DhtContact }
  | { status: "EVICTED_AND_ADDED"; contact: DhtContact; evicted: DhtContact }
  | { status: "FULL"; contact: DhtContact };

export class KBucket {
  private contacts: DhtContact[] = [];

  constructor(public readonly kSize: number = 8) {}

  /**
   * Thêm hoặc cập nhật contact vào K-Bucket
   */
  public addOrUpdate(contact: DhtContact): BucketUpdateResult {
    const idx = this.contacts.findIndex((c) => c.nodeId.toLowerCase() === contact.nodeId.toLowerCase());

    if (idx !== -1) {
      // Đã tồn tại: Cập nhật thông tin và chuyển về cuối mảng (Most Recently Used - MRU)
      const existing = this.contacts[idx];
      existing.displayName = contact.displayName;
      existing.ip = contact.ip;
      existing.tcpPort = contact.tcpPort;
      existing.lastSeen = contact.lastSeen || Date.now();
      existing.failedPings = 0;

      // Di chuyển về đuôi
      this.contacts.splice(idx, 1);
      this.contacts.push(existing);
      return { status: "UPDATED", contact: existing };
    }

    // Chưa tồn tại trong bucket
    if (this.contacts.length < this.kSize) {
      const newContact: DhtContact = {
        ...contact,
        lastSeen: contact.lastSeen || Date.now(),
        failedPings: 0
      };
      this.contacts.push(newContact);
      return { status: "ADDED", contact: newContact };
    }

    // Bucket đã đầy: Kiểm tra contact cũ nhất (đầu mảng - LRU)
    const oldest = this.contacts[0];
    if (oldest.failedPings > 0) {
      // Node cũ nhất đang chập chờn hoặc không phản hồi -> trục xuất (evict) và thay bằng node mới
      this.contacts.shift();
      const newContact: DhtContact = {
        ...contact,
        lastSeen: contact.lastSeen || Date.now(),
        failedPings: 0
      };
      this.contacts.push(newContact);
      return { status: "EVICTED_AND_ADDED", contact: newContact, evicted: oldest };
    }

    return { status: "FULL", contact };
  }

  /**
   * Xóa contact khỏi bucket
   */
  public remove(nodeId: string): boolean {
    const idx = this.contacts.findIndex((c) => c.nodeId.toLowerCase() === nodeId.toLowerCase());
    if (idx !== -1) {
      this.contacts.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Tìm contact theo nodeId
   */
  public get(nodeId: string): DhtContact | undefined {
    return this.contacts.find((c) => c.nodeId.toLowerCase() === nodeId.toLowerCase());
  }

  /**
   * Lấy contact cũ nhất (LRU - đầu hàng đợi)
   */
  public getOldest(): DhtContact | undefined {
    return this.contacts[0];
  }

  /**
   * Lấy toàn bộ contacts trong bucket
   */
  public getAll(): DhtContact[] {
    return [...this.contacts];
  }

  public size(): number {
    return this.contacts.length;
  }

  public isFull(): boolean {
    return this.contacts.length >= this.kSize;
  }
}

