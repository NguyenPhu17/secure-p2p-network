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
import {
  DhtContact,
  generateNodeId,
  generateNodeIdFromPublicKey,
  xorDistance,
  StoredValue,
  IDhtPersistentStore,
  MailboxMessage,
  getMailboxKey
} from "./dht-types.js";
import { RoutingTable } from "./routing-table.js";

export interface DhtNodeOptions {
  displayName: string;
  ip: string;
  tcpPort: number;
  channel: IChannel;
  logger: Logger;
  publicKey?: string;
  nodeId?: string;
  kSize?: number;
  alpha?: number; // Hệ số song song trong iterative lookup (mặc định 3)
  pingIntervalMs?: number; // Chu kỳ ping kiểm tra liveness (mặc định 3000ms)
  rpcTimeoutMs?: number;   // Timeout cho mỗi RPC request (mặc định 2000ms)
  republishIntervalMs?: number; // Chu kỳ Kademlia republishing (mặc định 3600000ms = 1h)
  partitionHealingIntervalMs?: number; // Chu kỳ tự động hàn gắn phân mảnh mạng (mặc định 5000ms)
  persistentStore?: IDhtPersistentStore; // Lưu trữ bền vững SQLite
  bootstrapPeers?: Array<{ ip: string; port: number }>;
}

interface PendingRequest {
  resolve: (res: any) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout;
}

export class DhtNode {
  public readonly localNodeId: string;
  public readonly publicKey?: string;
  public readonly localInfo: PeerInfo;
  private channel: IChannel;
  private logger: Logger;
  public readonly routingTable: RoutingTable;

  private alpha: number;
  private pingIntervalMs: number;
  private rpcTimeoutMs: number;
  private republishIntervalMs: number;
  private partitionHealingIntervalMs: number;
  private persistentStore?: IDhtPersistentStore;
  private bootstrapPeers: Array<{ ip: string; port: number }> = [];
  private knownBootstrapPool: Map<string, { ip: string; port: number }> = new Map();

  // Lưu trữ cặp key-value phân tán trên node (L1 Cache)
  private storage: Map<string, StoredValue> = new Map();

  // Quản lý các yêu cầu RPC đang chờ phản hồi
  private pendingRequests: Map<string, PendingRequest> = new Map();

  // Callbacks phát sự kiện khi danh bạ thay đổi
  private peerJoinedListeners: Array<(peer: PeerInfo) => void> = [];
  private peerLeftListeners: Array<(peer: PeerInfo) => void> = [];

  private maintenanceTimer: NodeJS.Timeout | null = null;
  private republishTimer: NodeJS.Timeout | null = null;
  private healingTimer: NodeJS.Timeout | null = null;
  private isClosing = false;

  constructor(opts: DhtNodeOptions) {
    this.publicKey = opts.publicKey;
    if (opts.nodeId) {
      this.localNodeId = opts.nodeId;
    } else if (opts.publicKey) {
      this.localNodeId = generateNodeIdFromPublicKey(opts.publicKey);
    } else {
      // Chuẩn P2P: Node ID được sinh từ SHA1(PublicKey) thay vì SHA1(displayName)
      const { publicKey } = crypto.generateKeyPairSync("ed25519");
      this.publicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
      this.localNodeId = generateNodeIdFromPublicKey(this.publicKey);
    }

    this.localInfo = {
      displayName: opts.displayName,
      ip: opts.ip,
      tcpPort: opts.tcpPort,
      lastSeen: Date.now(),
      nodeId: this.localNodeId,
      publicKey: this.publicKey
    };
    this.channel = opts.channel;
    this.logger = opts.logger;
    this.routingTable = new RoutingTable(this.localNodeId, opts.kSize || 8);
    this.alpha = opts.alpha || 3;
    this.pingIntervalMs = opts.pingIntervalMs || 3000;
    this.rpcTimeoutMs = opts.rpcTimeoutMs || 2000;
    this.republishIntervalMs = opts.republishIntervalMs || 3600000; // Mặc định 1h theo chuẩn Kademlia
    this.partitionHealingIntervalMs = opts.partitionHealingIntervalMs || 5000; // Mặc định 5s quét hàn gắn phân mảnh
    this.persistentStore = opts.persistentStore;

    if (opts.bootstrapPeers) {
      this.bootstrapPeers = [...opts.bootstrapPeers];
      for (const bp of opts.bootstrapPeers) {
        this.knownBootstrapPool.set(`${bp.ip}:${bp.port}`, { ip: bp.ip, port: bp.port });
      }
    }
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
   * Lưu trữ cặp key-value vào cả bộ nhớ RAM và Persistent SQLite Store
   */
  public saveToStorage(
    key: string,
    value: any,
    ttlMs: number,
    publisher: string,
    isLocalPublished = false
  ): void {
    const expiresAt = Date.now() + ttlMs;
    const entry: StoredValue = {
      value,
      expiresAt,
      publisher,
      isLocalPublished
    };
    this.storage.set(key, entry);

    if (this.persistentStore) {
      try {
        this.persistentStore.saveDhtRecord(key, value, expiresAt, publisher, isLocalPublished);
      } catch (err: any) {
        this.logger.warn("DHT", `Lỗi khi lưu DHT record '${key}' vào SQLite: ${err.message}`);
      }
    }
  }

  /**
   * Xóa bản ghi khỏi RAM và SQLite
   */
  public deleteFromStorage(key: string): void {
    this.storage.delete(key);
    if (this.persistentStore) {
      try {
        this.persistentStore.deleteDhtRecord(key);
      } catch (err: any) {
        this.logger.warn("DHT", `Lỗi khi xóa DHT record '${key}' khỏi SQLite: ${err.message}`);
      }
    }
  }

  /**
   * Khởi động DHT Node, phục hồi dữ liệu từ SQLite và kích hoạt bảo trì + republishing
   */
  public async start(): Promise<void> {
    this.logger.info(
      "DHT",
      `Khởi động DHT Node '${this.localInfo.displayName}' (Node ID: ${this.localNodeId.substring(0, 8)}...)`
    );

    // 1. Phục hồi dữ liệu DHT từ Persistent Store SQLite (Chống mất mát khi Churn/Restart)
    if (this.persistentStore) {
      try {
        const persisted = this.persistentStore.getAllUnexpiredDhtRecords(Date.now());
        for (const [key, val] of persisted.entries()) {
          this.storage.set(key, val);
        }
        this.logger.info(
          "DHT",
          `💾 [DHT PERSISTENCE] Đã phục hồi thành công ${persisted.size} bản ghi DHT từ cơ sở dữ liệu SQLite bền vững.`
        );
      } catch (err: any) {
        this.logger.warn("DHT", `Lỗi khi nạp dữ liệu DHT từ SQLite: ${err.message}`);
      }
    }

    // 2. Lưu thông tin bản thân vào storage (cả RAM và SQLite)
    this.saveToStorage(
      this.localNodeId,
      this.localInfo,
      365 * 24 * 3600 * 1000,
      this.localInfo.displayName,
      true
    );

    // 3. Bắt đầu chu trình bảo trì và kiểm tra liveness phi tập trung
    this.startMaintenanceLoop();

    // 4. Bắt đầu chu trình Kademlia Periodic Republishing
    this.startRepublishLoop();

    // 5. Bắt đầu chu trình tự động hàn gắn phân mảnh mạng (Network Partition Healing)
    this.startPartitionHealingLoop();
  }

  /**
   * Gia nhập mạng DHT thông qua danh sách các Bootstrap Nodes
   */
  public async bootstrap(bootstrapPeers: Array<{ ip: string; port: number }>): Promise<void> {
    // Lưu lại bootstrap peers và cập nhật vào knownBootstrapPool
    for (const bp of bootstrapPeers) {
      if (!this.bootstrapPeers.some((p) => p.ip === bp.ip && p.port === bp.port)) {
        this.bootstrapPeers.push(bp);
      }
      this.knownBootstrapPool.set(`${bp.ip}:${bp.port}`, { ip: bp.ip, port: bp.port });
    }

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
            nodeId: c.nodeId,
            publicKey: c.publicKey
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
        let valueToStore = payload.value;

        // Xử lý CRDT hợp nhất tin nhắn nếu là Distributed Mailbox
        if (valueToStore && valueToStore.type === "mailbox" && Array.isArray(valueToStore.messages)) {
          let existing = this.storage.get(payload.key);
          if (!existing && this.persistentStore) {
            existing = this.persistentStore.getDhtRecord(payload.key) || undefined;
          }

          if (
            existing &&
            existing.value &&
            existing.value.type === "mailbox" &&
            Array.isArray(existing.value.messages)
          ) {
            if (valueToStore.messages.length === 0) {
              // Yêu cầu dọn sạch Mailbox
              valueToStore = {
                type: "mailbox",
                recipient: valueToStore.recipient || existing.value.recipient,
                messages: []
              };
            } else {
              // Hợp nhất các tin nhắn offline theo message_id (Set-Union)
              const mergedMap = new Map<string, any>();
              for (const m of existing.value.messages) {
                mergedMap.set(m.message_id, m);
              }
              for (const m of valueToStore.messages) {
                mergedMap.set(m.message_id, m);
              }
              valueToStore = {
                type: "mailbox",
                recipient: valueToStore.recipient || existing.value.recipient,
                messages: Array.from(mergedMap.values())
              };
            }
          }
        }

        // Lưu bền vững vào cả RAM và SQLite
        this.saveToStorage(
          payload.key,
          valueToStore,
          payload.ttlMs || 3600000,
          payload.publisher,
          false
        );

        this.logger.info("DHT", `Đã lưu trữ DHT key '${payload.key.substring(0, 10)}...' từ ${payload.publisher} (Đã bền vững vào SQLite)`);

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
        } else if (from) {
          await this.channel.sendMessage(from.ip, from.port, ackMsg);
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

        let entry = this.storage.get(payload.key);
        if (!entry && this.persistentStore) {
          entry = this.persistentStore.getDhtRecord(payload.key) || undefined;
          if (entry && entry.expiresAt > Date.now()) {
            this.storage.set(payload.key, entry);
          }
        }

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
              nodeId: c.nodeId,
              publicKey: c.publicKey
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
    if (!peer.displayName) return;
    
    // Chuẩn P2P: Node ID được sinh từ SHA1(PublicKey) thay vì SHA1(displayName)
    const nodeId = peer.nodeId || (peer.publicKey ? generateNodeIdFromPublicKey(peer.publicKey) : generateNodeId(peer.displayName));

    // Không thêm chính bản thân mình vào routing table (kiểm tra theo nodeId hoặc cặp IP:Port)
    const isSelf = nodeId.toLowerCase() === this.localNodeId.toLowerCase() ||
      (peer.ip === this.localInfo.ip && peer.tcpPort === this.localInfo.tcpPort);
    if (isSelf) return;

    const contact: DhtContact = {
      nodeId,
      displayName: peer.displayName,
      ip: peer.ip,
      tcpPort: peer.tcpPort,
      lastSeen: Date.now(),
      failedPings: 0,
      publicKey: peer.publicKey
    };

    // Ghi nhận vào pool known bootstrap để phục vụ tự động hàn gắn phân mảnh mạng
    this.knownBootstrapPool.set(`${peer.ip}:${peer.tcpPort}`, { ip: peer.ip, port: peer.tcpPort });

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
        nodeId,
        publicKey: peer.publicKey
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
          const pNodeId = peer.nodeId || (peer.publicKey ? generateNodeIdFromPublicKey(peer.publicKey) : generateNodeId(peer.displayName));
          if (pNodeId.toLowerCase() === this.localNodeId.toLowerCase()) continue;

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
              failedPings: 0,
              publicKey: peer.publicKey
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
   * Đồng thời lưu bền vững vào SQLite với cờ isLocalPublished = true
   */
  public async store(key: string, value: any, ttlMs: number = 3600000): Promise<number> {
    // 1. Lưu bản sao trên chính mình (RAM + SQLite, đánh dấu sở hữu bản quyền dữ liệu)
    this.saveToStorage(key, value, ttlMs, this.localInfo.displayName, true);

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
   * Kiểm tra RAM -> SQLite -> Iterative Network Lookup
   */
  public async findValue(key: string): Promise<{ found: boolean; value?: any }> {
    // 1. Kiểm tra local cache (RAM)
    let local = this.storage.get(key);

    // 2. Nếu chưa có trên RAM, thử kiểm tra cơ sở dữ liệu SQLite bền vững
    if (!local && this.persistentStore) {
      local = this.persistentStore.getDhtRecord(key) || undefined;
      if (local && local.expiresAt > Date.now()) {
        this.storage.set(key, local);
      }
    }

    if (local && local.expiresAt > Date.now()) {
      return { found: true, value: local.value };
    }

    // 3. Tìm kiếm trên mạng qua Iterative Value Lookup
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
          // Lưu cache lại trên node (cả RAM và SQLite)
          this.saveToStorage(key, resp.value, 300000, contact.displayName, false);
          return { found: true, value: resp.value };
        }
      } catch {}
    }

    return { found: false };
  }

  /**
   * ============================================================================
   * DISTRIBUTED MAILBOX: HÀNG ĐỢI TIN NHẮN OFFLINE PHÂN TÁN QUA DHT
   * ============================================================================
   */

  /**
   * Lưu một tin nhắn offline vào Distributed Mailbox của người nhận trên DHT.
   * Dữ liệu được replicate trên K node gần hash(receiver) nhất.
   */
  public async depositMailbox(
    mailboxKey: string,
    message: MailboxMessage,
    ttlMs: number = 24 * 3600 * 1000
  ): Promise<boolean> {
    // 1. Lấy mailbox hiện tại nếu có
    let messages: MailboxMessage[] = [];
    let local = this.storage.get(mailboxKey);
    if (!local && this.persistentStore) {
      local = this.persistentStore.getDhtRecord(mailboxKey) || undefined;
    }

    if (local && local.value && local.value.type === "mailbox" && Array.isArray(local.value.messages)) {
      messages = [...local.value.messages];
    } else {
      const remote = await this.findValue(mailboxKey);
      if (remote.found && remote.value && remote.value.type === "mailbox" && Array.isArray(remote.value.messages)) {
        messages = [...remote.value.messages];
      }
    }

    // Chống trùng lặp theo message_id
    if (!messages.some((m) => m.message_id === message.message_id)) {
      messages.push(message);
    }

    const mailboxValue = {
      type: "mailbox",
      recipient: message.receiver,
      messages
    };

    // 2. Replicate phân tán tới K node gần mailboxKey
    const storedCount = await this.store(mailboxKey, mailboxValue, ttlMs);
    return storedCount > 0;
  }

  /**
   * Dọn sạch các tin nhắn đã đọc trong Distributed Mailbox trên DHT
   */
  public async clearMailbox(mailboxKey: string, recipient: string): Promise<boolean> {
    const emptyMailbox = {
      type: "mailbox",
      recipient,
      messages: []
    };
    const storedCount = await this.store(mailboxKey, emptyMailbox, 3600000);
    return storedCount > 0;
  }

  /**
   * ============================================================================
   * KADEMLIA PERIODIC REPUBLISHING: TỰ ĐỘNG PHÁT TÁN LẠI DỮ LIỆU ĐỊNH KỲ
   * ============================================================================
   */

  private startRepublishLoop(): void {
    if (this.republishTimer) clearInterval(this.republishTimer);
    this.republishTimer = setInterval(async () => {
      if (this.isClosing) return;
      await this.runRepublish();
    }, this.republishIntervalMs);
  }

  /**
   * Kademlia Periodic Republishing:
   * Quét toàn bộ dữ liệu do chính node này công bố (isLocalPublished)
   * và phát tán lại DHT_STORE tới K node lân cận gần key nhất.
   */
  public async runRepublish(): Promise<number> {
    const now = Date.now();
    let count = 0;

    const publishedRecords: Array<{ key: string; value: any; remainingTtl: number }> = [];

    for (const [key, entry] of this.storage.entries()) {
      if (entry.isLocalPublished && entry.expiresAt > now) {
        publishedRecords.push({
          key,
          value: entry.value,
          remainingTtl: Math.max(60000, entry.expiresAt - now)
        });
      }
    }

    if (publishedRecords.length === 0) return 0;

    this.logger.info(
      "DHT",
      `🔄 [KADEMLIA REPUBLISH] Bắt đầu phát tán định kỳ ${publishedRecords.length} bản ghi sở hữu tới K node lân cận...`
    );

    for (const rec of publishedRecords) {
      if (this.isClosing) break;
      try {
        const closest = await this.iterativeFindNode(rec.key);
        for (const peer of closest) {
          const msgId = crypto.randomUUID();
          const storeMsg: BaseMessage<DhtStorePayload> = {
            type: MessageType.DHT_STORE,
            message_id: msgId,
            sender: this.localInfo.displayName,
            receiver: peer.displayName,
            seq: 0,
            timestamp: Date.now(),
            payload: {
              key: rec.key,
              value: rec.value,
              ttlMs: rec.remainingTtl,
              publisher: this.localInfo.displayName,
              publisherNodeId: this.localNodeId
            },
            nonce: null,
            mac_or_signature: null
          };

          await this.channel.sendMessage(peer.ip, peer.tcpPort, storeMsg);
        }
        count++;
        this.logger.info(
          "DHT",
          `✅ [REPUBLISH SUCCESS] Đã phát tán lại key '${rec.key.substring(0, 10)}...' tới ${closest.length} node lân cận.`
        );
      } catch (err: any) {
        this.logger.warn("DHT", `Lỗi khi republish key '${rec.key}': ${err.message}`);
      }
    }

    return count;
  }

  /**
   * Tự quảng bá sự hiện diện của mình lên mạng DHT
   */
  public async announceSelf(): Promise<void> {
    // 1. Lưu thông tin dưới key là localNodeId (bảo toàn định danh mật mã học SHA1(PublicKey))
    await this.store(this.localNodeId, this.localInfo, 3600000);

    // 2. Lưu thông tin dưới key là SHA-1(displayName) để hỗ trợ tìm kiếm theo tên
    const nameKey = generateNodeId(this.localInfo.displayName);
    if (nameKey !== this.localNodeId) {
      // Identity Consensus: Kiểm tra xung đột tên (Name Collision)
      const existing = await this.findValue(nameKey);
      if (
        existing.found &&
        existing.value &&
        existing.value.nodeId &&
        existing.value.nodeId.toLowerCase() !== this.localNodeId.toLowerCase()
      ) {
        this.logger.warn(
          "DHT",
          `⚠️ [NAME COLLISION] Phát hiện xung đột tên: Tên hiển thị '${this.localInfo.displayName}' đã được sử dụng bởi Node ID ${existing.value.nodeId.substring(0, 8)}... Nhờ chuẩn Node ID = SHA1(PublicKey), bảng K-bucket không bị ghi đè.`
        );
      } else {
        await this.store(nameKey, this.localInfo, 3600000);
      }
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

    // Dọn dẹp storage các bản ghi hết hạn (RAM + SQLite)
    const now = Date.now();
    for (const [key, entry] of this.storage.entries()) {
      if (entry.expiresAt <= now && key !== this.localNodeId) {
        this.deleteFromStorage(key);
      }
    }
    if (this.persistentStore) {
      this.persistentStore.cleanupExpiredDhtRecords(now);
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
      nodeId: c.nodeId,
      publicKey: c.publicKey
    }));
  }

  /**
   * Hàn gắn phân mảnh mạng (Network Partition Healing):
   * Định kỳ quét các bootstrap peers và historical known nodes bị mất kết nối (bị xóa khỏi K-bucket).
   * Khi đường truyền phục hồi, tự động ping tái kết nối, hợp nhất routing table và kéo lại dữ liệu.
   */
  public async healPartition(): Promise<boolean> {
    if (this.isClosing) return false;

    const activeContacts = this.routingTable.getAll();
    const missingCandidates: Array<{ ip: string; port: number }> = [];

    // 1. Kiểm tra bootstrap peers được cấu hình ban đầu
    for (const bp of this.bootstrapPeers) {
      if (bp.ip === this.localInfo.ip && bp.port === this.localInfo.tcpPort) continue;
      const isActive = activeContacts.some((c) => c.ip === bp.ip && c.tcpPort === bp.port);
      if (!isActive) {
        missingCandidates.push(bp);
      }
    }

    // 2. Kiểm tra known peers trong pool lịch sử (cho phép seed node cũng hàn gắn được)
    for (const kp of this.knownBootstrapPool.values()) {
      if (kp.ip === this.localInfo.ip && kp.port === this.localInfo.tcpPort) continue;
      const isActive = activeContacts.some((c) => c.ip === kp.ip && c.tcpPort === kp.port);
      const isAlready = missingCandidates.some((m) => m.ip === kp.ip && m.port === kp.port);
      if (!isActive && !isAlready) {
        missingCandidates.push(kp);
      }
    }

    if (missingCandidates.length === 0) {
      return false;
    }

    let healedCount = 0;
    for (const candidate of missingCandidates) {
      if (this.isClosing) break;

      const pong = await this.sendPing(candidate.ip, candidate.port);
      if (pong) {
        this.logger.info(
          "DHT",
          `🩹 [PARTITION HEALING] Tái kết nối thành công với peer '${candidate.ip}:${candidate.port}' (${pong.displayName}). Đang hàn gắn 2 nửa mạng...`
        );
        this.addOrUpdateContact(pong);
        healedCount++;

        // Kích hoạt lại Iterative Lookup để khám phá lại toàn bộ các node thuộc phân vùng bên kia
        await this.iterativeFindNode(this.localNodeId);

        // Tự quảng bá lại thông tin của mình sang nửa mạng vừa được kết nối
        await this.announceSelf();
      }
    }

    if (healedCount > 0) {
      this.logger.info(
        "DHT",
        `✅ [PARTITION HEALED] Phân mảnh mạng đã được hàn gắn thành công! Bảng định tuyến K-bucket hiện có ${this.routingTable.size()} node.`
      );
      return true;
    }

    return false;
  }

  private startPartitionHealingLoop(): void {
    if (this.healingTimer) clearInterval(this.healingTimer);

    this.healingTimer = setInterval(async () => {
      if (this.isClosing) return;
      try {
        await this.healPartition();
      } catch (err: any) {
        // Tránh unhandled rejection trong background interval
      }
    }, this.partitionHealingIntervalMs);
  }

  public async close(): Promise<void> {
    this.isClosing = true;
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if (this.republishTimer) {
      clearInterval(this.republishTimer);
      this.republishTimer = null;
    }
    if (this.healingTimer) {
      clearInterval(this.healingTimer);
      this.healingTimer = null;
    }

    // Hủy toàn bộ pending RPCs
    for (const [, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error("DHT Node closing"));
    }
    this.pendingRequests.clear();
  }
}

