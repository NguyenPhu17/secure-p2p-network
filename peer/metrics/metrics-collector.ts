/**
 * MetricsCollector - Thu thập số liệu giám sát chuẩn Prometheus
 * Cung cấp cả System Metrics (CPU, RAM, Event Loop) và Custom P2P Application Metrics.
 */

import client from "prom-client";

export class MetricsCollector {
  private static instance: MetricsCollector | null = null;
  public readonly registry: client.Registry;

  // 1. Thước đo số lượng Peer đang online
  public readonly activePeersGauge: client.Gauge<"node">;

  // 2. Thước đo tổng số tin nhắn gửi và nhận
  public readonly messagesCounter: client.Counter<"node" | "direction" | "type">;

  // 3. Thước đo số tin nhắn định tuyến chuyển tiếp đa chặng (Mesh Relay)
  public readonly relayCounter: client.Counter<"node" | "role">;

  // 4. Thước đo số lượng Key lưu trữ trên Kademlia DHT
  public readonly dhtKeysGauge: client.Gauge<"node">;

  // 5. Thước đo đồng hồ logic Lamport Clock
  public readonly lamportClockGauge: client.Gauge<"node">;

  // 6. Thước đo số lần đăng nhập / bảo mật
  public readonly authCounter: client.Counter<"status">;

  private constructor() {
    this.registry = new client.Registry();

    // Thu thập các thông số hệ thống mặc định (CPU, RAM, Node.js process, Garbage Collection)
    client.collectDefaultMetrics({
      register: this.registry,
      prefix: "p2p_system_"
    });

    // Khởi tạo các Custom P2P Metrics
    this.activePeersGauge = new client.Gauge({
      name: "p2p_active_peers_count",
      help: "Số lượng Peer Node đang online và kết nối trong mạng",
      labelNames: ["node"],
      registers: [this.registry]
    });

    this.messagesCounter = new client.Counter({
      name: "p2p_messages_total",
      help: "Tổng số tin nhắn (Chat/File) đã gửi hoặc nhận",
      labelNames: ["node", "direction", "type"],
      registers: [this.registry]
    });

    this.relayCounter = new client.Counter({
      name: "p2p_mesh_relays_total",
      help: "Tổng số gói tin được định tuyến chuyển tiếp qua Mesh Relay",
      labelNames: ["node", "role"],
      registers: [this.registry]
    });

    this.dhtKeysGauge = new client.Gauge({
      name: "p2p_dht_stored_keys_count",
      help: "Số lượng khóa dữ liệu được lưu trữ trên Kademlia DHT",
      labelNames: ["node"],
      registers: [this.registry]
    });

    this.lamportClockGauge = new client.Gauge({
      name: "p2p_lamport_clock_value",
      help: "Giá trị đồng hồ logic Leslie Lamport hiện tại của Node",
      labelNames: ["node"],
      registers: [this.registry]
    });

    this.authCounter = new client.Counter({
      name: "p2p_auth_attempts_total",
      help: "Tổng số lần xác thực đăng nhập (thành công, thất bại, hoặc bị khóa tài khoản)",
      labelNames: ["status"],
      registers: [this.registry]
    });
  }

  public static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  /**
   * Lấy toàn bộ số liệu dưới định dạng Prometheus Text Exposition
   */
  public async getMetricsText(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Content-Type chuẩn của Prometheus
   */
  public getContentType(): string {
    return this.registry.contentType;
  }
}
