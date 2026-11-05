/**
 * PeerController - Bộ điều phối cốt lõi của Peer Backend
 * Kết nối Registry, quản lý danh sách Peer, điều phối Chat 1-1, SQLite Store và Hàng đợi tin offline.
 */

import net from "node:net";
import {
  BaseMessage,
  MessageType,
  PeerInfo,
  RegisterPayload,
  RegisterAckPayload,
  HeartbeatAckPayload,
  ChatPayload,
  ChatAckPayload,
  PeerLeftPayload,
  RelayForwardPayload,
  RelayAckPayload
} from "../common/protocol.js";
import { IChannel } from "../common/channel.js";
import { PlainChannel } from "./channel/plain-channel.js";
import { MessageStore, MessageRecord } from "./db/message-store.js";
import { FileSender, FileTransferProgress } from "./transfer/file-sender.js";
import { FileReceiver } from "./transfer/file-receiver.js";
import { Logger } from "../common/logger.js";
import { config } from "../common/config.js";
import { FrameDecoder, encodeFrame } from "../common/framing.js";
import { DhtNode } from "./dht/dht-node.js";

export interface PeerControllerOptions {
  displayName: string;
  tcpPort: number;
  ip?: string;
  registryHost?: string;
  registryPort?: number;
  bootstrapPeers?: Array<{ ip: string; port: number }>;
  discoveryMode?: "dht" | "registry" | "hybrid";
  dbPath?: string;
  downloadDir?: string;
}

export type UIEventCallback = (event: string, data: any) => void;

export class PeerController {
  public readonly displayName: string;
  public readonly tcpPort: number;
  public readonly ip: string;
  public readonly discoveryMode: "dht" | "registry" | "hybrid";
  public readonly bootstrapPeers: Array<{ ip: string; port: number }>;
  private registryHost: string;
  private registryPort: number;

  private logger: Logger;
  private store: MessageStore;
  private channel: IChannel;
  private fileSender: FileSender;
  private fileReceiver: FileReceiver;
  private dht: DhtNode;

  // Socket kết nối tới Registry để đăng ký và heartbeat (dùng trong chế độ registry / legacy)
  private registrySocket: net.Socket | null = null;
  private registryDecoder = new FrameDecoder();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Bảng theo dõi các peer đang online trong bộ nhớ (Tối ưu RAM)
  private onlinePeers: Map<string, PeerInfo> = new Map();

  // Định tuyến đa chặng Mesh Relay:
  // 1. Giả lập chặn kết nối trực tiếp (Firewall / NAT / lỗi kết nối LAN)
  private simulatedBlockedPeers: Set<string> = new Set();
  // 2. Bộ nhớ đệm Node chuyển tiếp ưu tiên (Reverse Path Caching): peerName -> relayPeerName
  private preferredRelays: Map<string, string> = new Map();
  // 3. Cache ID các phiên relay gần nhất để chống xử lý lặp gói tin (Deduplication)
  private processedRelaySessions: Set<string> = new Set();

  // Callbacks thông báo tới UI Bridge
  private uiListeners: UIEventCallback[] = [];
  private isClosing = false;

  constructor(opts: PeerControllerOptions) {
    this.displayName = opts.displayName;
    this.tcpPort = opts.tcpPort;
    this.ip = opts.ip || "127.0.0.1";
    this.registryHost = opts.registryHost || config.registry.host;
    this.registryPort = opts.registryPort || config.registry.port;
    this.bootstrapPeers = opts.bootstrapPeers || [];

    // Tự động phân định chế độ Discovery:
    // 1. Nếu chỉ định opts.discoveryMode -> Dùng đúng mode đó
    // 2. Nếu có bootstrapPeers hoặc DISCOVERY_MODE="dht" -> Dùng "dht" (Pure P2P)
    // 3. Nếu opts.registryPort được truyền trong các bài test cũ -> Dùng "registry"
    // 4. Mặc định: "dht"
    if (opts.discoveryMode) {
      this.discoveryMode = opts.discoveryMode;
    } else if (this.bootstrapPeers.length > 0 || process.env.DISCOVERY_MODE === "dht") {
      this.discoveryMode = "dht";
    } else if (opts.registryPort) {
      this.discoveryMode = "registry";
    } else {
      this.discoveryMode = "dht";
    }

    this.logger = new Logger(`Peer:${this.displayName}`, config.peer.maxLogEntries);
    this.logger.enableFileLogging();

    const dbFile = opts.dbPath || `data/${this.displayName}.db`;
    this.store = new MessageStore(dbFile);

    // Giai đoạn 1: Dùng PlainChannel
    // TODO(SECURITY): Giai đoạn 2 thay thế bằng SecureChannel
    this.channel = new PlainChannel(this.ip, this.tcpPort, this.logger);

    // Khởi tạo File Transfer engine
    this.fileSender = new FileSender(this.channel, this.displayName, this.logger);
    this.fileReceiver = new FileReceiver(this.channel, this.displayName, this.logger, opts.downloadDir);

    // Khởi tạo Kademlia DHT Node (luôn khả dụng cho các tương tác DHT phân tán)
    this.dht = new DhtNode({
      displayName: this.displayName,
      ip: this.ip,
      tcpPort: this.tcpPort,
      channel: this.channel,
      logger: this.logger
    });

    // Lắng nghe sự kiện khám phá peer từ DHT
    this.dht.onPeerJoined((peer) => {
      if (peer.displayName !== this.displayName) {
        this.onlinePeers.set(peer.displayName, peer);
        this.store.upsertPeer(peer);
        this.emitUI("PEER_LIST_UPDATE", this.getOnlinePeers());
        this.flushPendingMessages(peer.displayName);
      }
    });

    this.dht.onPeerLeft((peer) => {
      this.onlinePeers.delete(peer.displayName);
      this.emitUI("PEER_LIST_UPDATE", this.getOnlinePeers());
    });
  }

  public getLogger(): Logger {
    return this.logger;
  }

  public getStore(): MessageStore {
    return this.store;
  }

  public getDhtNode(): DhtNode {
    return this.dht;
  }

  public getNodeId(): string {
    return this.dht.localNodeId;
  }

  public onUIEvent(listener: UIEventCallback): void {
    this.uiListeners.push(listener);
  }

  private emitUI(event: string, data: any): void {
    for (const listener of this.uiListeners) {
      try {
        listener(event, data);
      } catch (e) {
        // Tránh lỗi UI ảnh hưởng tới controller
      }
    }
  }

  /**
   * Khởi động Peer Node
   */
  public async start(): Promise<void> {
    this.logger.info(
      "SYSTEM",
      `Khởi động Peer Node '${this.displayName}' trên cổng TCP ${this.tcpPort}... [Chế độ Discovery: ${this.discoveryMode.toUpperCase()}]`
    );

    // 1. Khởi động P2P Channel
    await this.channel.init();

    // 2. Lắng nghe tin nhắn P2P từ các peer khác
    this.channel.onReceive((msg, from) => {
      this.handleIncomingP2PMessage(msg, from);
    });

    // 3. Khởi động DHT Node
    await this.dht.start();

    // 4. Gia nhập mạng theo chế độ đã chọn
    if (this.discoveryMode === "dht") {
      this.logger.info("DHT", "🚀 Mạng hoạt động chế độ Phi tập trung hoàn toàn (Pure P2P DHT Kademlia). Không cần Registry SPOF!");
      await this.dht.bootstrap(this.bootstrapPeers);
    } else if (this.discoveryMode === "registry") {
      await this.connectAndRegisterToRegistry();
    } else if (this.discoveryMode === "hybrid") {
      await this.dht.bootstrap(this.bootstrapPeers);
      await this.connectAndRegisterToRegistry();
    }
  }

  /**
   * Kết nối TCP tới Registry, gửi message REGISTER và duy trì HEARTBEAT
   */
  private async connectAndRegisterToRegistry(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.registrySocket = new net.Socket();

      this.registrySocket.connect(this.registryPort, this.registryHost, () => {
        this.logger.info("NETWORK", `Đã kết nối tới Registry tại ${this.registryHost}:${this.registryPort}`);

        // Gửi REGISTER message
        const regMsg: BaseMessage<RegisterPayload> = {
          type: MessageType.REGISTER,
          message_id: crypto.randomUUID(),
          sender: this.displayName,
          receiver: "REGISTRY",
          seq: 1,
          timestamp: Date.now(),
          payload: {
            ip: this.ip,
            tcpPort: this.tcpPort
          },
          nonce: null,
          mac_or_signature: null
        };

        this.registrySocket!.write(encodeFrame(regMsg));
      });

      this.registrySocket.on("data", (chunk: Buffer) => {
        this.registryDecoder.push(chunk, (msg: BaseMessage) => {
          this.handleRegistryMessage(msg, resolve, reject);
        });
      });

      this.registrySocket.on("error", (err: Error) => {
        this.logger.error("NETWORK", `Lỗi kết nối Registry: ${err.message}`);
      });

      this.registrySocket.on("close", () => {
        if (this.isClosing) return;
        this.logger.warn("NETWORK", "Mất kết nối với Registry. Sẽ thử kết nối lại sau 5s...");
        this.stopHeartbeat();
        setTimeout(() => {
          if (!this.isClosing) {
            this.connectAndRegisterToRegistry().catch(() => {});
          }
        }, config.peer.reconnectIntervalMs);
      });
    });
  }

  /**
   * Xử lý các phản hồi và sự kiện từ Registry
   */
  private handleRegistryMessage(
    msg: BaseMessage,
    onRegistered?: () => void,
    onRegisterError?: (err: Error) => void
  ): void {
    this.logger.info(
      "PROTOCOL",
      `Nhận thông điệp từ Registry: [${msg.type}]`,
      msg.payload,
      { direction: "IN", messageType: msg.type, peer: "REGISTRY" }
    );

    switch (msg.type) {
      case MessageType.REGISTER_ACK: {
        const payload = msg.payload as RegisterAckPayload;
        if (payload.status === "OK") {
          this.logger.info("PROTOCOL", `Đăng ký thành công! Danh sách peer online: ${payload.peers.length}`);

          // Cập nhật danh sách peer online
          this.onlinePeers.clear();
          for (const p of payload.peers) {
            if (p.displayName !== this.displayName) {
              this.onlinePeers.set(p.displayName, p);
              this.store.upsertPeer(p);
            }
          }

          // Bắt đầu gửi Heartbeat định kỳ 5s
          this.startHeartbeat();

          this.emitUI("PEER_LIST_UPDATE", this.getOnlinePeers());
          if (onRegistered) onRegistered();
        } else {
          const err = new Error(`Đăng ký bị từ chối: ${payload.reason}`);
          this.logger.error("PROTOCOL", err.message);
          this.emitUI("ERROR_ALERT", payload.reason || "Đăng ký thất bại");
          if (onRegisterError) onRegisterError(err);
        }
        break;
      }

      case MessageType.HEARTBEAT_ACK: {
        // Heartbeat thành công, không cần xử lý thêm
        break;
      }

      case MessageType.PEER_JOINED: {
        const p = msg.payload as PeerInfo;
        if (p.displayName !== this.displayName) {
          this.logger.info("PROTOCOL", `Peer mới online: '${p.displayName}' (${p.ip}:${p.tcpPort})`);
          this.onlinePeers.set(p.displayName, p);
          this.store.upsertPeer(p);
          this.emitUI("PEER_LIST_UPDATE", this.getOnlinePeers());

          // Khi peer đối tác vừa online, tự động gửi các tin nhắn đang chờ (Offline queue flush)
          this.flushPendingMessages(p.displayName);
        }
        break;
      }

      case MessageType.PEER_LEFT: {
        const payload = msg.payload as PeerLeftPayload;
        this.logger.warn("PROTOCOL", `Peer offline: '${payload.displayName}' (${payload.reason})`);
        this.onlinePeers.delete(payload.displayName);
        this.emitUI("PEER_LIST_UPDATE", this.getOnlinePeers());
        break;
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = config.registry.heartbeatIntervalMs;
    this.heartbeatTimer = setInterval(() => {
      if (this.registrySocket && !this.registrySocket.destroyed) {
        const hb: BaseMessage = {
          type: MessageType.HEARTBEAT,
          message_id: crypto.randomUUID(),
          sender: this.displayName,
          receiver: "REGISTRY",
          seq: 0,
          timestamp: Date.now(),
          payload: {},
          nonce: null,
          mac_or_signature: null
        };
        this.registrySocket.write(encodeFrame(hb));
      }
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Giả lập chặn kết nối trực tiếp (Firewall / NAT / lỗi đường truyền mạng LAN)
   * Phục vụ kiểm thử định tuyến đa chặng Mesh Relay
   */
  public simulateFirewallBlock(peerName: string, blocked = true): void {
    if (blocked) {
      this.simulatedBlockedPeers.add(peerName);
      this.logger.warn("ROUTING", `🛡️ [FIREWALL SIMULATION] Đã kích hoạt tường lửa chặn kết nối trực tiếp với '${peerName}'`);
    } else {
      this.simulatedBlockedPeers.delete(peerName);
      this.logger.info("ROUTING", `🔓 [FIREWALL SIMULATION] Đã mở lại kết nối trực tiếp với '${peerName}'`);
    }
    this.emitUI("FIREWALL_STATUS_UPDATE", { peer: peerName, blocked });
  }

  public isSimulatedBlocked(peerName: string): boolean {
    return this.simulatedBlockedPeers.has(peerName);
  }

  public getBlockedPeers(): string[] {
    return Array.from(this.simulatedBlockedPeers);
  }

  /**
   * Tìm kiếm thông tin liên lạc (IP:Port) của một Peer từ RAM, DHT hoặc SQLite
   */
  public resolvePeerContact(peerName: string): PeerInfo | null {
    let peer = this.onlinePeers.get(peerName);
    if (!peer) {
      peer = this.dht.getKnownPeers().find((p) => p.displayName === peerName);
      if (peer) {
        this.onlinePeers.set(peer.displayName, peer);
      }
    }
    if (!peer) {
      peer = this.store.getPeer(peerName) || undefined;
    }
    return peer || null;
  }

  /**
   * Lấy danh sách các Peer trung gian tiềm năng để chuyển tiếp gói tin (Relay Candidates)
   */
  private getCandidateRelays(excludeTarget: string, excludeRoutes: string[] = []): PeerInfo[] {
    const list: PeerInfo[] = [];
    const seen = new Set<string>();

    const all = [
      ...Array.from(this.onlinePeers.values()),
      ...this.dht.getKnownPeers(),
      ...this.store.getKnownPeers()
    ];

    for (const p of all) {
      if (
        p.displayName !== this.displayName &&
        p.displayName !== excludeTarget &&
        !excludeRoutes.includes(p.displayName) &&
        !this.simulatedBlockedPeers.has(p.displayName) &&
        !seen.has(p.displayName)
      ) {
        seen.add(p.displayName);
        list.push(p);
      }
    }

    return list;
  }

  /**
   * Gửi thông điệp tới một peer mục tiêu:
   * 1. Thử gửi trực tiếp 1-chặng (Direct P2P Socket).
   * 2. Nếu đường truyền trực tiếp bị lỗi (hoặc bị chặn firewall/NAT), tự động kích hoạt định tuyến đa chặng (Mesh Relay) qua peer thứ 3.
   */
  public async sendMessageToPeer(
    targetPeerName: string,
    message: BaseMessage,
    preferredRelay?: string
  ): Promise<{ success: boolean; relayedVia?: string; route?: string[] }> {
    const targetContact = this.resolvePeerContact(targetPeerName);
    if (!targetContact && !this.simulatedBlockedPeers.has(targetPeerName)) {
      this.logger.warn(
        "ROUTING",
        `Peer '${targetPeerName}' hiện không online trong mạng. Không thể gửi hoặc định tuyến.`
      );
      return { success: false };
    }

    // 1. KIỂM TRA ĐƯỜNG TRUYỀN TRỰC TIẾP (1-HOP DIRECT SOCKET)
    const isDirectBlocked = this.simulatedBlockedPeers.has(targetPeerName);

    if (!isDirectBlocked) {
      const peer = targetContact;
      if (peer) {
        const sentDirect = await this.channel.sendMessage(peer.ip, peer.tcpPort, message);
        if (sentDirect) {
          this.logger.info(
            "ROUTING",
            `⚡ [DIRECT P2P] Gửi trực tiếp 1-chặng thành công tới '${targetPeerName}' (${peer.ip}:${peer.tcpPort})`,
            { messageType: message.type, target: targetPeerName },
            { direction: "OUT", messageType: message.type, peer: targetPeerName }
          );
          return { success: true, route: [this.displayName, targetPeerName] };
        } else {
          this.logger.warn(
            "ROUTING",
            `⚠️ [DIRECT FAILED] Không thể kết nối trực tiếp tới '${targetPeerName}' (${peer.ip}:${peer.tcpPort}). Kích hoạt Mesh Relay đa chặng...`
          );
        }
      }
    } else {
      this.logger.warn(
        "ROUTING",
        `🛡️ [FIREWALL/NAT] Kết nối trực tiếp 1-chặng tới '${targetPeerName}' bị chặn bởi Firewall/NAT. Tự động chuyển hướng qua Mesh Relay...`
      );
    }

    // 2. KÍCH HOẠT ĐỊNH TUYẾN ĐA CHẶNG QUA PEER THỨ BA (MESH OVERLAY ROUTING)
    const candidates = this.getCandidateRelays(targetPeerName, [this.displayName]);

    // Ưu tiên relay đã biết (Reverse path caching) hoặc preferredRelay được chỉ định
    const relayToTryFirst = preferredRelay || this.preferredRelays.get(targetPeerName);
    if (relayToTryFirst) {
      const idx = candidates.findIndex((c) => c.displayName === relayToTryFirst);
      if (idx > -1) {
        const [preferred] = candidates.splice(idx, 1);
        candidates.unshift(preferred);
      }
    }

    if (candidates.length === 0) {
      this.logger.warn(
        "ROUTING",
        `❌ [MESH ROUTING] Không tìm thấy Peer trung gian nào khả dụng trong mạng để chuyển tiếp tới '${targetPeerName}'.`
      );
      return { success: false };
    }

    for (const relay of candidates) {
      const relaySessionId = crypto.randomUUID();
      const relayPayload: RelayForwardPayload = {
        relaySessionId,
        originSender: this.displayName,
        finalReceiver: targetPeerName,
        hopCount: 1,
        maxHops: 3,
        route: [this.displayName],
        innerMessage: message
      };

      const relayEnvelope: BaseMessage<RelayForwardPayload> = {
        type: MessageType.RELAY_FORWARD,
        message_id: crypto.randomUUID(),
        sender: this.displayName,
        receiver: relay.displayName,
        seq: 0,
        timestamp: Date.now(),
        payload: relayPayload,
        nonce: null,
        mac_or_signature: null
      };

      const sentToRelay = await this.channel.sendMessage(relay.ip, relay.tcpPort, relayEnvelope);
      if (sentToRelay) {
        const routePath = [this.displayName, relay.displayName, targetPeerName];
        this.preferredRelays.set(targetPeerName, relay.displayName);
        this.logger.info(
          "ROUTING",
          `🔀 [MESH RELAY] Đã định tuyến gói tin [${message.type}] qua Peer trung gian '${relay.displayName}' (Tuyến: ${routePath.join(" ➔ ")})`,
          { relaySessionId, route: routePath },
          { direction: "OUT", messageType: "RELAY_FORWARD", peer: relay.displayName }
        );
        return {
          success: true,
          relayedVia: relay.displayName,
          route: routePath
        };
      } else {
        this.logger.warn(
          "ROUTING",
          `Không thể kết nối tới Peer trung gian '${relay.displayName}'. Đang thử peer kế tiếp...`
        );
      }
    }

    return { success: false };
  }

  /**
   * Xử lý gói tin định tuyến RELAY_FORWARD nhận được từ một Peer khác
   */
  private async handleRelayForwardMessage(
    relayPayload: RelayForwardPayload,
    from?: { ip: string; port: number }
  ): Promise<void> {
    const { relaySessionId, originSender, finalReceiver, hopCount, maxHops, route, innerMessage } = relayPayload;

    // 1. Chống xử lý lặp lại phiên relay (Deduplication)
    if (this.processedRelaySessions.has(relaySessionId)) {
      this.logger.warn("ROUTING", `[RELAY DROP] Bỏ qua gói tin relay trùng lặp session: ${relaySessionId}`);
      return;
    }
    this.processedRelaySessions.add(relaySessionId);
    // Tự động xóa khỏi cache sau 60s (unref để không block process shutdown)
    setTimeout(() => {
      this.processedRelaySessions.delete(relaySessionId);
    }, 60000).unref();

    // 2. NẾU ĐÍCH CUỐI CÙNG LÀ CHÍNH MÌNH (Destination reached!)
    if (finalReceiver === this.displayName) {
      const fullRoute = [...route, this.displayName];
      const directRelayPeer = route[route.length - 1]; // Peer trung gian trực tiếp chuyển cho mình (VD: Charlie)

      this.logger.info(
        "ROUTING",
        `🎯 [RELAY REACHED] Đã nhận gói tin [${innerMessage.type}] từ '${originSender}' qua tuyến Mesh Relay: [${fullRoute.join(" ➔ ")}] (Tổng số chặng: ${hopCount})`,
        { relaySessionId, fullRoute, innerType: innerMessage.type },
        { direction: "IN", messageType: "RELAY_FORWARD", peer: originSender }
      );

      // Cập nhật reverse route cache để khi gửi lại ACK hoặc reply ta ưu tiên đi qua relay này
      if (directRelayPeer) {
        this.preferredRelays.set(originSender, directRelayPeer);
      }

      // Bóc tách gói tin gốc và xử lý nội bộ
      await this.handleIncomingP2PMessage(innerMessage, from, fullRoute, directRelayPeer);
      return;
    }

    // 3. NẾU MÌNH LÀ NODE TRUNG GIAN (INTERMEDIARY ROUTER - VD: CHARLIE)
    // 3.1 Chống lặp vòng định tuyến (Routing Loop Prevention)
    if (route.includes(this.displayName)) {
      this.logger.warn(
        "ROUTING",
        `⚠️ [RELAY LOOP] Phát hiện vòng lặp định tuyến! Tuyến: [${route.join(" ➔ ")}] đã đi qua '${this.displayName}'. Hủy gói tin.`,
        { relaySessionId }
      );
      return;
    }

    // 3.2 Kiểm tra giới hạn số chặng (TTL / Max Hops check)
    if (hopCount >= maxHops) {
      this.logger.warn(
        "ROUTING",
        `⚠️ [RELAY TTL EXCEEDED] Gói tin từ '${originSender}' tới '${finalReceiver}' vượt quá số chặng tối đa (${hopCount}/${maxHops}). Hủy gói tin.`,
        { relaySessionId }
      );
      return;
    }

    this.logger.info(
      "ROUTING",
      `🔄 [RELAY FORWARD] Node '${this.displayName}' đóng vai trò ROUTER CHUYỂN TIẾP: Chuyển gói tin từ '${originSender}' ➔ '${finalReceiver}' (Chặng ${hopCount + 1}/${maxHops})`,
      { relaySessionId, currentRoute: [...route, this.displayName] },
      { direction: "INTERNAL", messageType: "RELAY_FORWARD", peer: finalReceiver }
    );

    const updatedRoute = [...route, this.displayName];
    const nextHopPayload: RelayForwardPayload = {
      ...relayPayload,
      hopCount: hopCount + 1,
      route: updatedRoute
    };

    const forwardEnvelope: BaseMessage<RelayForwardPayload> = {
      type: MessageType.RELAY_FORWARD,
      message_id: crypto.randomUUID(),
      sender: this.displayName,
      receiver: finalReceiver,
      seq: 0,
      timestamp: Date.now(),
      payload: nextHopPayload,
      nonce: null,
      mac_or_signature: null
    };

    // 3.3 Thử chuyển tiếp trực tiếp tới đích cuối cùng (finalReceiver)
    let targetContact = this.resolvePeerContact(finalReceiver);
    let forwarded = false;

    if (targetContact && !this.simulatedBlockedPeers.has(finalReceiver)) {
      forwarded = await this.channel.sendMessage(targetContact.ip, targetContact.tcpPort, forwardEnvelope);
      if (forwarded) {
        this.logger.info(
          "ROUTING",
          `✅ [RELAY SUCCESS] Đã chuyển tiếp thành công gói tin tới đích '${finalReceiver}' qua tuyến: [${updatedRoute.join(" ➔ ")} ➔ ${finalReceiver}]`
        );
        return;
      }
    }

    // 3.4 Nếu không gửi trực tiếp được tới finalReceiver, thử tìm relay kế tiếp (Dynamic Multi-hop Mesh)
    if (!forwarded && nextHopPayload.hopCount < nextHopPayload.maxHops) {
      const candidates = this.getCandidateRelays(finalReceiver, updatedRoute);
      for (const nextRelay of candidates) {
        forwardEnvelope.receiver = nextRelay.displayName;
        const sent = await this.channel.sendMessage(nextRelay.ip, nextRelay.tcpPort, forwardEnvelope);
        if (sent) {
          this.logger.info(
            "ROUTING",
            `🔀 [RELAY MULTI-HOP] Không kết nối trực tiếp được '${finalReceiver}', đã chuyển tiếp qua node phụ '${nextRelay.displayName}' (Chặng ${nextHopPayload.hopCount}/${nextHopPayload.maxHops})`
          );
          forwarded = true;
          break;
        }
      }
    }

    if (!forwarded) {
      this.logger.error(
        "ROUTING",
        `❌ [RELAY FAILED] Node '${this.displayName}' không thể tìm thấy đường chuyển tiếp tới '${finalReceiver}'. Gói tin bị hủy.`
      );
    }
  }

  /**
   * Xử lý gói tin P2P nhận được từ một Peer khác (trực tiếp hoặc qua Relay)
   */
  private async handleIncomingP2PMessage(
    msg: BaseMessage,
    from?: { ip: string; port: number },
    viaRoute?: string[],
    relayedBy?: string
  ): Promise<void> {
    // 1. Nếu là thông điệp thuộc giao thức DHT Kademlia, chuyển trực tiếp cho DHT Node xử lý
    if (msg.type.startsWith("DHT_")) {
      await this.dht.handleIncomingMessage(msg, from);
      return;
    }

    // 2. Nếu là gói tin định tuyến RELAY_FORWARD, chuyển cho Relay Router xử lý
    if (msg.type === MessageType.RELAY_FORWARD) {
      await this.handleRelayForwardMessage(msg.payload as RelayForwardPayload, from);
      return;
    }

    this.logger.info(
      "PROTOCOL",
      `Nhận [${msg.type}] từ peer '${msg.sender}' (seq: ${msg.seq})${relayedBy ? ` [qua Relay: ${relayedBy}]` : ""}`,
      msg.payload,
      { direction: "IN", messageType: msg.type, peer: msg.sender }
    );

    switch (msg.type) {
      case MessageType.CHAT: {
        const payload = msg.payload as ChatPayload;
        const record: MessageRecord = {
          message_id: msg.message_id,
          conversation_id: `conv_${msg.sender}`,
          sender: msg.sender,
          receiver: this.displayName,
          direction: "in",
          seq: msg.seq,
          timestamp: msg.timestamp,
          body: payload.body,
          status: "delivered",
          type: "chat",
          created_at: Date.now(),
          nonce: msg.nonce,
          mac_or_signature: msg.mac_or_signature,
          route: viaRoute || [msg.sender, this.displayName],
          relayed_by: relayedBy || null
        };

        // Lưu vào SQLite với cơ chế Deduplication
        const { isDuplicate } = this.store.saveMessage(record);

        // Luôn gửi lại CHAT_ACK để bên gửi biết tin đã tới (kể cả khi nhận trùng lặp)
        // Ưu tiên gửi lại qua Relay nếu tin nhắn này đến qua Relay
        await this.sendChatAck(msg.sender, msg.message_id, relayedBy);

        if (!isDuplicate) {
          // Chỉ phát thông báo lên UI nếu đây là tin mới
          this.emitUI("NEW_MESSAGE", record);
        } else {
          this.logger.warn("PROTOCOL", `Bỏ qua tin nhắn trùng lặp message_id: ${msg.message_id}`);
        }
        break;
      }

      case MessageType.CHAT_ACK: {
        const payload = msg.payload as ChatAckPayload;
        this.store.updateMessageStatus(payload.ack_message_id, "delivered", viaRoute, relayedBy);
        this.logger.info(
          "PROTOCOL",
          `Tin nhắn ${payload.ack_message_id} đã được ACK (delivered)${relayedBy ? ` [qua Relay: ${relayedBy}]` : ""}.`
        );
        this.emitUI("MESSAGE_STATUS_UPDATE", {
          message_id: payload.ack_message_id,
          status: "delivered",
          relayed_by: relayedBy,
          route: viaRoute
        });
        break;
      }

      case MessageType.FILE_META: {
        const metaPayload = msg.payload;
        this.fileReceiver.handleFileMeta(msg, (prog) => {
          this.emitUI("FILE_PROGRESS", prog);
        });

        // Lưu thông tin file vào database
        this.store.saveFileMeta({
          file_id: metaPayload.file_id,
          conversation_id: `conv_${msg.sender}`,
          file_name: metaPayload.fileName,
          size: metaPayload.fileSize,
          hash: metaPayload.fileHash,
          status: "transferring",
          local_path: "",
          direction: "in",
          created_at: Date.now()
        });

        // Tạo tin nhắn thông báo file trong cuộc hội thoại
        const fileMsgRecord: MessageRecord = {
          message_id: crypto.randomUUID(),
          conversation_id: `conv_${msg.sender}`,
          sender: msg.sender,
          receiver: this.displayName,
          direction: "in",
          seq: msg.seq,
          timestamp: msg.timestamp,
          body: `[File đính kèm: ${metaPayload.fileName} (${(metaPayload.fileSize / 1024).toFixed(1)} KB)]`,
          status: "delivered",
          type: "file",
          file_id: metaPayload.file_id,
          created_at: Date.now(),
          route: viaRoute || [msg.sender, this.displayName],
          relayed_by: relayedBy || null
        };
        this.store.saveMessage(fileMsgRecord);
        this.emitUI("NEW_MESSAGE", fileMsgRecord);
        break;
      }

      case MessageType.FILE_CHUNK: {
        const senderInfo = this.onlinePeers.get(msg.sender);
        await this.fileReceiver.handleFileChunk(
          msg,
          senderInfo,
          (prog) => {
            this.emitUI("FILE_PROGRESS", prog);
          },
          (completed) => {
            this.store.updateFileStatus(completed.file_id, "completed");
            this.logger.info("SYSTEM", `Tệp ${completed.fileName} đã được lưu thành công tại: ${completed.localPath}`);
            this.emitUI("FILE_COMPLETED", completed);
          }
        );
        break;
      }

      case MessageType.FILE_ACK: {
        this.fileSender.handleFileAck(msg.payload.file_id, msg.payload.chunkIndex, msg.payload.status);
        break;
      }

      default:
        this.logger.warn("PROTOCOL", `Chưa hỗ trợ P2P message type: ${msg.type}`);
        break;
    }
  }

  /**
   * Gửi phản hồi CHAT_ACK cho bên gửi (Hỗ trợ cả gửi trực tiếp và qua Mesh Relay)
   */
  private async sendChatAck(targetPeer: string, originalMessageId: string, preferredRelay?: string): Promise<void> {
    const ackMsg: BaseMessage<ChatAckPayload> = {
      type: MessageType.CHAT_ACK,
      message_id: crypto.randomUUID(),
      sender: this.displayName,
      receiver: targetPeer,
      seq: 0,
      timestamp: Date.now(),
      payload: { ack_message_id: originalMessageId },
      nonce: null,
      mac_or_signature: null
    };

    await this.sendMessageToPeer(targetPeer, ackMsg, preferredRelay);
  }

  /**
   * Gửi tin nhắn Chat văn bản tới một peer
   */
  public async sendChatMessage(receiver: string, body: string): Promise<MessageRecord> {
    const message_id = crypto.randomUUID();
    const now = Date.now();
    const seq = this.store.getNextSeq(receiver);

    const record: MessageRecord = {
      message_id,
      conversation_id: `conv_${receiver}`,
      sender: this.displayName,
      receiver,
      direction: "out",
      seq,
      timestamp: now,
      body,
      status: "pending",
      type: "chat",
      created_at: now,
      nonce: null,
      mac_or_signature: null
    };

    // 1. Lưu tin nhắn vào SQLite với trạng thái ban đầu là "pending"
    this.store.saveMessage(record);
    this.emitUI("NEW_MESSAGE", record);

    // 2. Thử gửi (Direct P2P trước, tự động Relay nếu direct lỗi)
    await this.attemptSendMessage(record);

    return record;
  }

  /**
   * Thử gửi một tin nhắn đi (tự động thử Direct trước, fallback sang Mesh Relay)
   */
  private async attemptSendMessage(record: MessageRecord): Promise<boolean> {
    const isOnline = this.getOnlinePeers().some((p) => p.displayName === record.receiver);

    if (!isOnline && !this.simulatedBlockedPeers.has(record.receiver)) {
      this.logger.warn(
        "PROTOCOL",
        `Peer '${record.receiver}' hiện đang offline. Tin nhắn ${record.message_id} lưu trong hàng đợi pending.`
      );
      return false;
    }

    const chatMsg: BaseMessage<ChatPayload> = {
      type: MessageType.CHAT,
      message_id: record.message_id,
      sender: this.displayName,
      receiver: record.receiver,
      seq: record.seq,
      timestamp: record.timestamp,
      payload: { body: record.body },
      nonce: null,
      mac_or_signature: null
    };

    const res = await this.sendMessageToPeer(record.receiver, chatMsg);
    if (res.success) {
      this.store.updateMessageStatus(record.message_id, "sent", res.route, res.relayedVia);
      record.status = "sent";
      record.route = res.route;
      record.relayed_by = res.relayedVia;
      this.emitUI("MESSAGE_STATUS_UPDATE", {
        message_id: record.message_id,
        status: "sent",
        relayed_by: res.relayedVia,
        route: res.route
      });
      return true;
    } else {
      this.logger.warn(
        "ROUTING",
        `Không thể chuyển phát tin nhắn ${record.message_id} tới '${record.receiver}' (cả Direct và Relay đều thất bại). Giữ trạng thái pending trong hàng đợi.`
      );
      return false;
    }
  }

  /**
   * Tự động gửi lại các tin nhắn pending khi peer đối tác vừa online (Offline Queue)
   */
  public async flushPendingMessages(peerName: string): Promise<void> {
    const pendingList = this.store.getPendingMessages(peerName);
    if (pendingList.length > 0) {
      this.logger.info("PROTOCOL", `Đang gửi lại ${pendingList.length} tin nhắn pending cho '${peerName}'...`);
      for (const msg of pendingList) {
        await this.attemptSendMessage(msg);
      }
    }
  }

  /**
   * Gửi file dạng chunk 64KB tới peer đối tác
   */
  public async sendFile(receiver: string, filePath: string): Promise<{ file_id: string; success: boolean; error?: string }> {
    const peer = this.onlinePeers.get(receiver);
    if (!peer) {
      return { file_id: "", success: false, error: `Peer '${receiver}' hiện không online.` };
    }

    const res = await this.fileSender.sendFile(peer, filePath, (prog) => {
      this.emitUI("FILE_PROGRESS", prog);
    });

    if (res.success) {
      const fileName = filePath.split(/[/\\]/).pop() || "file";
      const fileMsgRecord: MessageRecord = {
        message_id: crypto.randomUUID(),
        conversation_id: `conv_${receiver}`,
        sender: this.displayName,
        receiver,
        direction: "out",
        seq: this.store.getNextSeq(receiver),
        timestamp: Date.now(),
        body: `[File đính kèm: ${fileName}]`,
        status: "delivered",
        type: "file",
        file_id: res.file_id,
        created_at: Date.now()
      };
      this.store.saveMessage(fileMsgRecord);
      this.emitUI("NEW_MESSAGE", fileMsgRecord);
    }

    return res;
  }

  public getOnlinePeers(): PeerInfo[] {
    if (this.discoveryMode === "dht" || this.onlinePeers.size === 0) {
      const dhtPeers = this.dht.getKnownPeers();
      for (const p of dhtPeers) {
        if (p.displayName !== this.displayName && !this.onlinePeers.has(p.displayName)) {
          this.onlinePeers.set(p.displayName, p);
        }
      }
    }
    return Array.from(this.onlinePeers.values());
  }

  public getKnownPeers(): PeerInfo[] {
    return this.store.getKnownPeers();
  }

  public getChatHistory(peer: string, limit = 50, beforeTimestamp?: number): MessageRecord[] {
    return this.store.getHistory(peer, limit, beforeTimestamp);
  }

  public deleteChatHistory(peer: string): void {
    this.store.deleteConversation(peer);
    this.emitUI("CHAT_HISTORY_CLEARED", { peer });
  }

  public async close(): Promise<void> {
    this.isClosing = true;
    this.stopHeartbeat();
    await this.dht.close();
    if (this.registrySocket) {
      this.registrySocket.removeAllListeners();
      if (!this.registrySocket.destroyed) {
        this.registrySocket.destroy();
      }
      this.registrySocket = null;
    }
    await this.channel.close();
    this.store.close();
    this.logger.close();
  }
}
