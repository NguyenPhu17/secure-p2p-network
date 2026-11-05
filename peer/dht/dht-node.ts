/**
 * DhtNode - Cốt lõi của Hệ thống Kademlia Distributed Hash Table (Pure P2P)
 * Thực thi toàn bộ giao thức phân tán: PING, FIND_NODE, STORE, FIND_VALUE,
 * giải thuật tìm kiếm lặp (Iterative Lookup), và giám sát sống/chết (Liveness) phi tập trung.
 */

import crypto from "node:crypto";
import {
  BaseMessage,
  MessageType,
  PeerInfo,
  DhtPingPayload,
  DhtPongPayload,
  DhtFindNodePayload,
  DhtFindNodeRespPayload,
  DhtStorePayload,
  DhtStoreAckPayload,
  DhtFindValuePayload,
  DhtFindValueRespPayload
} from "../../common/protocol.js";
import { IChannel } from "../../common/channel.js";
import { Logger } from "../../common/logger.js";
import { DhtContact, generateNodeId, xorDistance } from "./dht-types.js";
import { RoutingTable } from "./routing-table.js";

export interface DhtNodeOptions {
  displayName: string;
  ip: string;
  tcpPort: number;
  channel: IChannel;
  logger: Logger;
  kSize?: number;
  alpha?: number; // Hệ số song song trong iterative lookup (mặc định 3)
  pingIntervalMs?: number; // Chu kỳ ping kiểm tra liveness (mặc định 3000ms)
  rpcTimeoutMs?: number;   // Timeout cho mỗi RPC request (mặc định 2000ms)
}

interface StoredValue {
  value: any;
  expiresAt: number;
  publisher: string;
}

interface PendingRequest {
  resolve: (res: any) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout;
}

export class DhtNode {
  public readonly localNodeId: string;
  public readonly localInfo: PeerInfo;
  private channel: IChannel;
  private logger: Logger;
  public readonly routingTable: RoutingTable;

  private alpha: number;
  private pingIntervalMs: number;
  private rpcTimeoutMs: number;

  // Lưu trữ cặp key-value phân tán trên node
  private storage: Map<string, StoredValue> = new Map();

  // Quản lý các yêu cầu RPC đang chờ phản hồi
  private pendingRequests: Map<string, PendingRequest> = new Map();

  // Callbacks phát sự kiện khi danh bạ thay đổi
  private peerJoinedListeners: Array<(peer: PeerInfo) => void> = [];
  private peerLeftListeners: Array<(peer: PeerInfo) => void> = [];

  private maintenanceTimer: NodeJS.Timeout | null = null;
  private isClosing = false;

  constructor(opts: DhtNodeOptions) {
    this.localNodeId = generateNodeId(opts.displayName);
    this.localInfo = {
      displayName: opts.displayName,
      ip: opts.ip,
      tcpPort: opts.tcpPort,
      lastSeen: Date.now(),
      nodeId: this.localNodeId
    };
    this.channel = opts.channel;
    this.logger = opts.logger;
    this.routingTable = new RoutingTable(this.localNodeId, opts.kSize || 8);
    this.alpha = opts.alpha || 3;
    this.pingIntervalMs = opts.pingIntervalMs || 3000;
    this.rpcTimeoutMs = opts.rpcTimeoutMs || 2000;
  }

  public onPeerJoined(listener: (peer: PeerInfo) => void): void {
    this.peerJoinedListeners.push(listener);
  }

  public onPeerLeft(listener: (peer: PeerInfo) => void): void {
    this.peerLeftListeners.push(listener);
  }

  private emitPeerJoined(peer: PeerInfo): void {
    for (const fn of this.peerJoinedListeners) {
      try {
        fn(peer);
      } catch (e) {}
    }
  }

  private emitPeerLeft(peer: PeerInfo): void {
    for (const fn of this.peerLeftListeners) {
      try {
        fn(peer);
      } catch (e) {}
    }
  }

  /**
   * Khởi động DHT Node và tiến trình bảo trì định kỳ
   */
  public async start(): Promise<void> {
    this.logger.info(
      "DHT",
      `Khởi động DHT Node '${this.localInfo.displayName}' (Node ID: ${this.localNodeId.substring(0, 8)}...)`
    );

    // Lưu thông tin bản thân vào local storage
    this.storage.set(this.localNodeId, {
      value: this.localInfo,
      expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
      publisher: this.localInfo.displayName
    });

    // Bắt đầu chu trình bảo trì và kiểm tra liveness phi tập trung
    this.startMaintenanceLoop();
  }

  /**
   * Gia nhập mạng DHT thông qua danh sách các Bootstrap Nodes
   */
  public async bootstrap(bootstrapPeers: Array<{ ip: string; port: number }>): Promise<void> {
    if (bootstrapPeers.length === 0) {
      this.logger.info("DHT", "Không có bootstrap peer, node hoạt động như Seed Node khởi nguồn.");
      return;
    }

    this.logger.info("DHT", `Bắt đầu bootstrap vào mạng DHT qua ${bootstrapPeers.length} bootstrap peer...`);

    // 1. Ping thử tất cả bootstrap peers để kết nối ban đầu
    const initialPeers: PeerInfo[] = [];
    for (const peer of bootstrapPeers) {
      // Bỏ qua nếu là chính mình
      if (peer.ip === this.localInfo.ip && peer.port === this.localInfo.tcpPort) continue;

      const pong = await this.sendPing(peer.ip, peer.port);
      if (pong) {
        initialPeers.push(pong);
        this.addOrUpdateContact(pong);
      }
    }

    if (initialPeers.length === 0) {
      this.logger.warn("DHT", "Không kết nối được bootstrap peer nào. Sẽ tiếp tục làm seed hoặc chờ node khác kết nối.");
      return;
    }

    this.logger.info("DHT", `Đã kết nối thành công ${initialPeers.length} bootstrap peer. Bắt đầu Iterative Lookup...`);

    // 2. Tìm kiếm lặp các node gần với localNodeId để làm đầy các K-Buckets
    await this.iterativeFindNode(this.localNodeId);

    // 3. Quảng bá (Announce) thông tin của mình lên các node gần nhất
    await this.announceSelf();
  }

  /**
   * Xử lý gói tin DHT nhận được từ P2P Channel
   */
  public async handleIncomingMessage(msg: BaseMessage, from?: { ip: string; port: number }): Promise<boolean> {
    switch (msg.type) {
      case MessageType.DHT_PING: {
        const payload = msg.payload as DhtPingPayload;
        this.addOrUpdateContact(payload.senderInfo);

        // Gửi phản hồi DHT_PONG
        const pongMsg: BaseMessage<DhtPongPayload> = {
          type: MessageType.DHT_PONG,
          message_id: crypto.randomUUID(),
          sender: this.localInfo.displayName,
          receiver: msg.sender,
          seq: 0,
          timestamp: Date.now(),
          payload: {
            req_id: msg.message_id,
            responderNodeId: this.localNodeId,
            responderInfo: this.localInfo
          },
          nonce: null,
          mac_or_signature: null
        };

        const targetIp = payload.senderInfo.ip || from?.ip || "127.0.0.1";
        const targetPort = payload.senderInfo.tcpPort;
        await this.channel.sendMessage(targetIp, targetPort, pongMsg);
        return true;
      }

      case MessageType.DHT_PONG: {
        const payload = msg.payload as DhtPongPayload;
        this.addOrUpdateContact(payload.responderInfo);
        this.resolvePending(payload.req_id, payload.responderInfo);
        return true;
      }

      case MessageType.DHT_FIND_NODE: {
        const payload = msg.payload as DhtFindNodePayload;
        this.addOrUpdateContact(payload.senderInfo);

        // Tìm K nodes gần nhất với targetNodeId trong routing table
        const closestContacts = this.routingTable.getClosestNodes(payload.targetNodeId, this.routingTable.kSize);
        // Loại bỏ người gửi khỏi danh sách trả về
        const closestPeers: PeerInfo[] = closestContacts
          .filter((c) => c.nodeId.toLowerCase() !== payload.senderNodeId.toLowerCase())
          .map((c) => ({
            displayName: c.displayName,
            ip: c.ip,
            tcpPort: c.tcpPort,
            lastSeen: c.lastSeen,
            nodeId: c.nodeId
          }));

        const respMsg: BaseMessage<DhtFindNodeRespPayload> = {
          type: MessageType.DHT_FIND_NODE_RESP,
          message_id: crypto.randomUUID(),
          sender: this.localInfo.displayName,
          receiver: msg.sender,
          seq: 0,
          timestamp: Date.now(),
          payload: {
            req_id: msg.message_id,
            targetNodeId: payload.targetNodeId,
            nodes: closestPeers
          },
          nonce: null,
          mac_or_signature: null
        };

        const targetIp = payload.senderInfo.ip || from?.ip || "127.0.0.1";
        const targetPort = payload.senderInfo.tcpPort;
        await this.channel.sendMessage(targetIp, targetPort, respMsg);
        return true;
      }

      case MessageType.DHT_FIND_NODE_RESP: {
        const payload = msg.payload as DhtFindNodeRespPayload;
        // Bổ sung các node nhận được vào routing table
        for (const peer of payload.nodes) {
          this.addOrUpdateContact(peer);
        }
        this.resolvePending(payload.req_id, payload.nodes);
        return true;
      }

      case MessageType.DHT_STORE: {
        const payload = msg.payload as DhtStorePayload;
        this.storage.set(payload.key, {
          value: payload.value,
          expiresAt: Date.now() + (payload.ttlMs || 3600000),
          publisher: payload.publisher
        });

        this.logger.info("DHT", `Đã lưu trữ DHT key '${payload.key.substring(0, 10)}...' từ ${payload.publisher}`);

        const ackMsg: BaseMessage<DhtStoreAckPayload> = {
          type: MessageType.DHT_STORE_ACK,
          message_id: crypto.randomUUID(),
          sender: this.localInfo.displayName,
          receiver: msg.sender,
          seq: 0,
          timestamp: Date.now(),
          payload: {
            req_id: msg.message_id,
            key: payload.key,
            status: "OK"
          },
          nonce: null,
          mac_or_signature: null
        };

        const contact = this.routingTable.get(payload.publisherNodeId);
        if (contact) {
          await this.channel.sendMessage(contact.ip, contact.tcpPort, ackMsg);
        }
        return true;
      }

      case MessageType.DHT_STORE_ACK: {
        const payload = msg.payload as DhtStoreAckPayload;
        this.resolvePending(payload.req_id, payload.status === "OK");
        return true;
      }

      case MessageType.DHT_FIND_VALUE: {
        const payload = msg.payload as DhtFindValuePayload;
        this.addOrUpdateContact(payload.senderInfo);

        const entry = this.storage.get(payload.key);
        let respPayload: DhtFindValueRespPayload;

        if (entry && entry.expiresAt > Date.now()) {
          // Tìm thấy value trên node
          respPayload = {
            req_id: msg.message_id,
            key: payload.key,
            found: true,
            value: entry.value
          };
        } else {
          // Không có value: Trả về K node gần nhất với key
          const closest = this.routingTable.getClosestNodes(payload.key, this.routingTable.kSize);
          respPayload = {
            req_id: msg.message_id,
            key: payload.key,
            found: false,
            nodes: closest.map((c) => ({
              displayName: c.displayName,
              ip: c.ip,
              tcpPort: c.tcpPort,
              lastSeen: c.lastSeen,
              nodeId: c.nodeId
            }))
          };
        }

        const respMsg: BaseMessage<DhtFindValueRespPayload> = {
          type: MessageType.DHT_FIND_VALUE_RESP,
          message_id: crypto.randomUUID(),
          sender: this.localInfo.displayName,
          receiver: msg.sender,
          seq: 0,
          timestamp: Date.now(),
          payload: respPayload,
          nonce: null,
          mac_or_signature: null
        };

        const targetIp = payload.senderInfo.ip || from?.ip || "127.0.0.1";
        const targetPort = payload.senderInfo.tcpPort;
        await this.channel.sendMessage(targetIp, targetPort, respMsg);
        return true;
      }

      case MessageType.DHT_FIND_VALUE_RESP: {
        const payload = msg.payload as DhtFindValueRespPayload;
        if (!payload.found && payload.nodes) {
          for (const peer of payload.nodes) {
            this.addOrUpdateContact(peer);
          }
        }
        this.resolvePending(payload.req_id, payload);
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Thêm hoặc cập nhật một peer vào routing table
   */
  public addOrUpdateContact(peer: PeerInfo): void {
    if (!peer.displayName || peer.displayName === this.localInfo.displayName) return;
    const nodeId = peer.nodeId || generateNodeId(peer.displayName);

    const contact: DhtContact = {
      nodeId,
      displayName: peer.displayName,
      ip: peer.ip,
      tcpPort: peer.tcpPort,
      lastSeen: Date.now(),
      failedPings: 0
    };

    const isExisting = !!this.routingTable.get(nodeId);
    const result = this.routingTable.addOrUpdate(contact);

    if (result && (result.status === "ADDED" || (!isExisting && result.status === "UPDATED"))) {
      this.logger.info(
        "DHT",
        `[DHT DISCOVERY] Phát hiện Peer mới: '${peer.displayName}' (${peer.ip}:${peer.tcpPort}) [ID: ${nodeId.substring(0, 8)}...]`
      );
      this.emitPeerJoined({
        displayName: peer.displayName,
        ip: peer.ip,
        tcpPort: peer.tcpPort,
        lastSeen: Date.now(),
        nodeId
      });
    }

    if (result && result.status === "EVICTED_AND_ADDED" && result.evicted) {
      this.logger.warn(
        "DHT",
        `[DHT EVICTION] Trục xuất node cũ '${result.evicted.displayName}' do không phản hồi ping để nhường chỗ cho '${peer.displayName}'.`
      );
      this.emitPeerLeft(result.evicted);
    }
  }

  /**
   * Gửi RPC DHT_PING tới một node
   */
  public async sendPing(ip: string, port: number): Promise<PeerInfo | null> {
    const msgId = crypto.randomUUID();
    const pingMsg: BaseMessage<DhtPingPayload> = {
      type: MessageType.DHT_PING,
      message_id: msgId,
      sender: this.localInfo.displayName,
      receiver: "BROADCAST",
      seq: 0,
      timestamp: Date.now(),
      payload: {
        senderNodeId: this.localNodeId,
        senderInfo: this.localInfo
      },
      nonce: null,
      mac_or_signature: null
    };

    const sent = await this.channel.sendMessage(ip, port, pingMsg);
    if (!sent) return null;

    try {
      const resp = await this.waitForResponse<PeerInfo>(msgId, this.rpcTimeoutMs);
      return resp;
    } catch {
      return null;
    }
  }

  /**
   * Gửi RPC DHT_FIND_NODE tới một node cụ thể
   */
  public async sendFindNode(ip: string, port: number, targetNodeId: string): Promise<PeerInfo[]> {
    const msgId = crypto.randomUUID();
    const msg: BaseMessage<DhtFindNodePayload> = {
      type: MessageType.DHT_FIND_NODE,
      message_id: msgId,
      sender: this.localInfo.displayName,
      receiver: "PEER",
      seq: 0,
      timestamp: Date.now(),
      payload: {
        targetNodeId,
        senderNodeId: this.localNodeId,
        senderInfo: this.localInfo
      },
      nonce: null,
      mac_or_signature: null
    };

    const sent = await this.channel.sendMessage(ip, port, msg);
    if (!sent) return [];

    try {
      const nodes = await this.waitForResponse<PeerInfo[]>(msgId, this.rpcTimeoutMs);
      return nodes || [];
    } catch {
      return [];
    }
  }

  /**
   * Giải thuật tìm kiếm lặp (Iterative Node Lookup) theo chuẩn Kademlia
   * Truy vấn lặp qua các node gần nhất để hội tụ về targetNodeId.
   */
  public async iterativeFindNode(targetNodeId: string): Promise<PeerInfo[]> {
    const targetNorm = targetNodeId.toLowerCase();
    const queriedIds = new Set<string>();
    queriedIds.add(this.localNodeId);

    // Lấy shortlist ban đầu từ routing table
    let shortlist = this.routingTable.getClosestNodes(targetNorm, this.routingTable.kSize);
    if (shortlist.length === 0) return [];

    let hasCloser = true;
    let rounds = 0;
    const maxRounds = 8;

    while (hasCloser && rounds < maxRounds) {
      rounds++;
      // Chọn ra tối đa alpha node chưa được truy vấn gần target nhất
      const unqueried = shortlist.filter((c) => !queriedIds.has(c.nodeId.toLowerCase()));
      if (unqueried.length === 0) break;

      const candidates = unqueried.slice(0, this.alpha);
      for (const c of candidates) {
        queriedIds.add(c.nodeId.toLowerCase());
      }

      // Gửi FIND_NODE đồng thời tới các ứng viên (alpha concurrency)
      const promises = candidates.map((c) => this.sendFindNode(c.ip, c.tcpPort, targetNorm));
      const results = await Promise.all(promises);

      let foundNewNode = false;
      for (const nodes of results) {
        for (const peer of nodes) {
          const pNodeId = peer.nodeId || generateNodeId(peer.displayName);
          if (pNodeId.toLowerCase() === this.localNodeId) continue;

          this.addOrUpdateContact(peer);

          // Nếu chưa có trong shortlist thì thêm vào
          if (!shortlist.some((c) => c.nodeId.toLowerCase() === pNodeId.toLowerCase())) {
            foundNewNode = true;
            shortlist.push({
              nodeId: pNodeId,
              displayName: peer.displayName,
              ip: peer.ip,
              tcpPort: peer.tcpPort,
              lastSeen: Date.now(),
              failedPings: 0
            });
          }
        }
      }

      // Sắp xếp lại shortlist theo khoảng cách XOR tới target
      shortlist.sort((a, b) => {
        const da = xorDistance(a.nodeId, targetNorm);
        const db = xorDistance(b.nodeId, targetNorm);
        return da < db ? -1 : da > db ? 1 : 0;
      });

      // Giới hạn K nodes tốt nhất
      shortlist = shortlist.slice(0, this.routingTable.kSize);

      if (!foundNewNode) {
        hasCloser = false;
      }
    }

    return shortlist.map((c) => ({
      displayName: c.displayName,
      ip: c.ip,
      tcpPort: c.tcpPort,
      lastSeen: c.lastSeen,
      nodeId: c.nodeId
    }));
  }

  /**
   * Lưu trữ cặp key-value lên K node gần key nhất trong mạng DHT
   */
  public async store(key: string, value: any, ttlMs: number = 3600000): Promise<number> {
    // 1. Lưu bản sao trên chính mình
    this.storage.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      publisher: this.localInfo.displayName
    });

    // 2. Tìm K nodes gần key nhất
    const closest = await this.iterativeFindNode(key);
    let successCount = 1; // Bản thân đã lưu

    const promises = closest.map(async (peer) => {
      const msgId = crypto.randomUUID();
      const storeMsg: BaseMessage<DhtStorePayload> = {
        type: MessageType.DHT_STORE,
        message_id: msgId,
        sender: this.localInfo.displayName,
        receiver: peer.displayName,
        seq: 0,
        timestamp: Date.now(),
        payload: {
          key,
          value,
          ttlMs,
          publisher: this.localInfo.displayName,
          publisherNodeId: this.localNodeId
        },
        nonce: null,
        mac_or_signature: null
      };

      const sent = await this.channel.sendMessage(peer.ip, peer.tcpPort, storeMsg);
      if (!sent) return false;

      try {
        const ack = await this.waitForResponse<boolean>(msgId, this.rpcTimeoutMs);
        return !!ack;
      } catch {
        return false;
      }
    });

    const results = await Promise.all(promises);
    successCount += results.filter(Boolean).length;
    return successCount;
  }

  /**
   * Tìm kiếm giá trị theo key trên mạng DHT (Iterative Value Lookup)
   */
  public async findValue(key: string): Promise<{ found: boolean; value?: any }> {
    // Kiểm tra local cache
    const local = this.storage.get(key);
    if (local && local.expiresAt > Date.now()) {
      return { found: true, value: local.value };
    }

    // Tìm kiếm trên mạng
    const closest = this.routingTable.getClosestNodes(key, this.routingTable.kSize);
    for (const contact of closest) {
      const msgId = crypto.randomUUID();
      const req: BaseMessage<DhtFindValuePayload> = {
        type: MessageType.DHT_FIND_VALUE,
        message_id: msgId,
        sender: this.localInfo.displayName,
        receiver: contact.displayName,
        seq: 0,
        timestamp: Date.now(),
        payload: {
          key,
          senderNodeId: this.localNodeId,
          senderInfo: this.localInfo
        },
        nonce: null,
        mac_or_signature: null
      };

      const sent = await this.channel.sendMessage(contact.ip, contact.tcpPort, req);
      if (!sent) continue;

      try {
        const resp = await this.waitForResponse<DhtFindValueRespPayload>(msgId, this.rpcTimeoutMs);
        if (resp && resp.found) {
          // Lưu cache lại trên node
          this.storage.set(key, {
            value: resp.value,
            expiresAt: Date.now() + 300000,
            publisher: contact.displayName
          });
          return { found: true, value: resp.value };
        }
      } catch {}
    }

    return { found: false };
  }

  /**
   * Tự quảng bá sự hiện diện của mình lên mạng DHT
   */
  public async announceSelf(): Promise<void> {
    // 1. Lưu thông tin dưới key là localNodeId
    await this.store(this.localNodeId, this.localInfo, 3600000);
    // 2. Lưu thông tin dưới key là SHA-1(displayName)
    const nameKey = generateNodeId(this.localInfo.displayName);
    if (nameKey !== this.localNodeId) {
      await this.store(nameKey, this.localInfo, 3600000);
    }
  }

  /**
   * Tiến trình bảo trì liveness phi tập trung (Decentralized Heartbeat / Health Check)
   * Thay thế hoàn toàn vai trò Heartbeat của Registry tập trung.
   */
  private startMaintenanceLoop(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);

    this.maintenanceTimer = setInterval(async () => {
      if (this.isClosing) return;
      await this.runMaintenance();
    }, this.pingIntervalMs);
  }

  public async runMaintenance(): Promise<void> {
    const contacts = this.routingTable.getAll();

    for (const contact of contacts) {
      if (this.isClosing) break;

      const pong = await this.sendPing(contact.ip, contact.tcpPort);
      if (pong) {
        contact.failedPings = 0;
        contact.lastSeen = Date.now();
      } else {
        contact.failedPings += 1;
        // Nếu 2 lần liên tiếp không nhận được PONG -> Coi như peer đã ngắt kết nối
        if (contact.failedPings >= 2) {
          this.logger.warn(
            "DHT",
            `[DHT LIVENESS] Peer '${contact.displayName}' không phản hồi sau ${contact.failedPings} lần ping. Đánh dấu OFFLINE.`
          );
          this.routingTable.remove(contact.nodeId);
          this.emitPeerLeft(contact);
        }
      }
    }

    // Dọn dẹp storage các bản ghi hết hạn
    const now = Date.now();
    for (const [key, entry] of this.storage.entries()) {
      if (entry.expiresAt <= now && key !== this.localNodeId) {
        this.storage.delete(key);
      }
    }
  }

  /**
   * Helper đợi phản hồi RPC theo requestId với timeout
   */
  private waitForResponse<T>(reqId: string, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`DHT RPC timeout sau ${timeoutMs}ms (reqId: ${reqId})`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, { resolve, reject, timer });
    });
  }

  private resolvePending(reqId: string, data: any): void {
    const entry = this.pendingRequests.get(reqId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pendingRequests.delete(reqId);
      entry.resolve(data);
    }
  }

  public getKnownPeers(): PeerInfo[] {
    return this.routingTable.getAll().map((c) => ({
      displayName: c.displayName,
      ip: c.ip,
      tcpPort: c.tcpPort,
      lastSeen: c.lastSeen,
      nodeId: c.nodeId
    }));
  }

  public async close(): Promise<void> {
    this.isClosing = true;
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    // Hủy toàn bộ pending RPCs
    for (const [, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error("DHT Node closing"));
    }
    this.pendingRequests.clear();
  }
}

