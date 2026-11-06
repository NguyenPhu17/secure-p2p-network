/**
 * Leslie Lamport Logical Clocks & Vector Clocks
 * Cung cấp giải pháp cho bài toán Thứ tự sự kiện và Tính nhân quả (Causality)
 * trong Hệ thống Phân tán (Distributed Systems).
 *
 * Tiên đề Leslie Lamport (1978): "Time, Clocks, and the Ordering of Events in a Distributed System"
 * - Không có đồng hồ vật lý toàn cục đồng bộ tuyệt đối (Clock Skew / Clock Drift).
 * - Sử dụng Lamport Logical Clocks và Vector Clocks để xác định quan hệ nhân quả (Happened-Before a -> b).
 * - Xác định sự kiện đồng thời (Concurrency: a || b).
 * - Đảm bảo Lamport Total Order cho toàn bộ thông điệp trong mạng P2P Mesh.
 */

export class LamportClock {
  private clock: number;

  constructor(initialClock = 0) {
    this.clock = Math.max(0, initialClock);
  }

  /**
   * Lấy giá trị đồng hồ logic hiện tại
   */
  public getClock(): number {
    return this.clock;
  }

  /**
   * Thiết lập giá trị đồng hồ (phục vụ khôi phục từ SQLite DB khi khởi động lại node)
   */
  public setClock(val: number): void {
    this.clock = Math.max(this.clock, val);
  }

  /**
   * Bước nhảy đồng hồ cho sự kiện nội bộ hoặc TRƯỚC KHI gửi thông điệp:
   * L = L + 1
   */
  public tick(): number {
    this.clock += 1;
    return this.clock;
  }

  /**
   * Cập nhật đồng hồ KHI NHẬN thông điệp từ peer khác mang đồng hồ msgClock:
   * L_receiver = max(L_receiver, msgClock) + 1
   */
  public update(receivedClock?: number | null): number {
    const remote = receivedClock && typeof receivedClock === "number" ? receivedClock : 0;
    this.clock = Math.max(this.clock, remote) + 1;
    return this.clock;
  }
}

export type VectorClockMap = Record<string, number>;

export class VectorClock {
  private vector: VectorClockMap = {};

  constructor(initial: VectorClockMap = {}) {
    this.vector = { ...initial };
  }

  /**
   * Lấy bản sao của Vector Clock hiện tại
   */
  public getClock(): VectorClockMap {
    return { ...this.vector };
  }

  /**
   * Thiết lập lại vector clock
   */
  public setClock(newVector: VectorClockMap): void {
    this.vector = { ...newVector };
  }

  /**
   * Tăng đồng hồ của tiến trình/node hiện tại khi phát sinh sự kiện cục bộ hoặc gửi tin:
   * V[nodeId] = V[nodeId] + 1
   */
  public tick(nodeId: string): VectorClockMap {
    this.vector[nodeId] = (this.vector[nodeId] || 0) + 1;
    return this.getClock();
  }

  /**
   * Cập nhật Vector Clock khi nhận thông điệp từ mạng:
   * 1. Với mọi k: V[k] = max(V[k], V_msg[k])
   * 2. V[nodeId] = V[nodeId] + 1
   */
  public update(receivedVector: VectorClockMap | undefined | null, nodeId: string): VectorClockMap {
    if (receivedVector && typeof receivedVector === "object") {
      for (const [k, v] of Object.entries(receivedVector)) {
        if (typeof v === "number") {
          this.vector[k] = Math.max(this.vector[k] || 0, v);
        }
      }
    }
    this.vector[nodeId] = (this.vector[nodeId] || 0) + 1;
    return this.getClock();
  }

  /**
   * So sánh 2 Vector Clock để xác định quan hệ nhân quả (Happened-Before) hoặc Đồng thời (Concurrent):
   * - "BEFORE"     : V1 -> V2 (V1 xảy ra trước V2 theo quan hệ nhân quả)
   * - "AFTER"      : V2 -> V1 (V1 xảy ra sau V2)
   * - "EQUAL"      : V1 == V2 (Cùng một trạng thái sự kiện)
   * - "CONCURRENT" : V1 || V2 (Hai sự kiện diễn ra độc lập, không có quan hệ nhân quả)
   */
  public static compare(v1: VectorClockMap, v2: VectorClockMap): "BEFORE" | "AFTER" | "CONCURRENT" | "EQUAL" {
    const keys = new Set([...Object.keys(v1 || {}), ...Object.keys(v2 || {})]);
    let hasLess = false;
    let hasGreater = false;

    for (const key of keys) {
      const val1 = v1[key] || 0;
      const val2 = v2[key] || 0;
      if (val1 < val2) {
        hasLess = true;
      } else if (val1 > val2) {
        hasGreater = true;
      }
    }

    if (!hasLess && !hasGreater) {
      return "EQUAL";
    }
    if (hasLess && !hasGreater) {
      return "BEFORE";
    }
    if (hasGreater && !hasLess) {
      return "AFTER";
    }
    return "CONCURRENT";
  }
}

export interface CausalMessageComparable {
  lamport_clock?: number;
  sender: string;
  seq?: number;
  timestamp?: number;
  message_id?: string;
}

/**
 * Hàm so sánh Lamport Total Order (Thứ tự toàn phần Lamport):
 * Đảm bảo mọi node phân tán đều sắp xếp chuỗi sự kiện hoàn toàn giống nhau,
 * miễn nhiễm với Clock Drift và độ trễ mạng Mesh Relay.
 *
 * Quy tắc:
 * 1. So sánh lamport_clock (sự kiện có lamport_clock nhỏ hơn xảy ra trước).
 * 2. Nếu lamport_clock bằng nhau: Tie-breaker 1 bằng định danh sender (chuỗi từ điển nhỏ hơn đi trước).
 * 3. Nếu cùng sender: Tie-breaker 2 bằng sequence number (seq).
 * 4. Nếu seq bằng nhau: Tie-breaker 3 bằng physical timestamp.
 * 5. Cuối cùng: Tie-breaker 4 bằng message_id duy nhất.
 */
export function compareLamportOrder(a: CausalMessageComparable, b: CausalMessageComparable): number {
  const clockA = a.lamport_clock ?? 0;
  const clockB = b.lamport_clock ?? 0;

  if (clockA !== clockB) {
    return clockA - clockB;
  }

  if (a.sender !== b.sender) {
    return a.sender.localeCompare(b.sender);
  }

  const seqA = a.seq ?? 0;
  const seqB = b.seq ?? 0;
  if (seqA !== seqB) {
    return seqA - seqB;
  }

  const timeA = a.timestamp ?? 0;
  const timeB = b.timestamp ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }

  const idA = a.message_id || "";
  const idB = b.message_id || "";
  return idA.localeCompare(idB);
}
