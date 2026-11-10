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
  private maintenancePromise: Promise<void> | null = null;
  private healingPromise: Promise<boolean> | null = null;
  private verifyingEndpoints: Set<string> = new Set();
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
    isLocalPublished = false,
    lamportClock = 0,
    version = 1
  ): boolean {
    const existing = this.storage.get(key) || (this.persistentStore ? this.persistentStore.getDhtRecord(key) : null);
    if (existing && lamportClock > 0 && existing.lamport_clock) {
      if (lamportClock < existing.lamport_clock) {
        this.logger.warn(
          "DHT",
          `Từ chối ghi đè dữ liệu cũ: Lamport Clock nhận ${lamportClock} < hiện tại ${existing.lamport_clock} cho key '${key.substring(0, 10)}...'`
        );
        return false;
      }
      if (lamportClock === existing.lamport_clock && version < (existing.version || 1)) {
        return false;
      }
    }

    const expiresAt = Date.now() + ttlMs;
    const entry: StoredValue = {
      value,
      expiresAt,
      publisher,
      isLocalPublished,
      lamport_clock: lamportClock,
      version
    };
    this.storage.set(key, entry);

    if (this.persistentStore) {
      try {
        this.persistentStore.saveDhtRecord(
          key,
          value,
          expiresAt,
          publisher,
          isLocalPublished,
          lamportClock,
          version
        );
      } catch (err: any) {
        this.logger.warn("DHT", `Lỗi khi lưu DHT record '${key}' vào SQLite: ${err.message}`);
      }
    }
    return true;
  }

  /**
   * Lấy bản ghi lưu trữ DHT theo key (từ RAM hoặc SQLite Store)
   */
  public getStorageEntry(key: string): StoredValue | undefined {
    let entry = this.storage.get(key);
    if (!entry && this.persistentStore) {
      entry = this.persistentStore.getDhtRecord(key) || undefined;
    }
    return entry;
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
      if (
        peer.ip.trim().toLowerCase() === this.localInfo.ip.trim().toLowerCase() &&
        peer.port === this.localInfo.tcpPort
      ) {
        continue;
      }

      const pong = await this.sendPing(peer.ip, peer.port);
      if (pong && !this.isSelfPeer(pong)) {
        initialPeers.push(pong);
        this.addOrUpdateContact(pong);
      } else if (pong && this.isSelfPeer(pong)) {
        this.knownBootstrapPool.delete(this.getEndpointKey(peer.ip, peer.port));
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

        // Tìm K nodes gần nhất với targetNodeId trong routing table (chỉ trả về các node khỏe mạnh)
        const closestContacts = this.routingTable.getClosestNodes(payload.targetNodeId, this.routingTable.kSize);
        // Loại bỏ người gửi khỏi danh sách trả về
        const closestPeers: PeerInfo[] = closestContacts
          .filter((c) => c.nodeId.toLowerCase() !== payload.senderNodeId.toLowerCase() && c.failedPings === 0)
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
            nodes: closestPeers,
            responderInfo: this.localInfo
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
        // Chỉ thêm trực tiếp node đã trực tiếp phản hồi (verified), KHÔNG thêm mù quáng gossip từ bên thứ 3
        if (payload.responderInfo) {
          this.addOrUpdateContact(payload.responderInfo);
        }
        this.resolvePending(payload.req_id, payload);
        return true;
      }

      case MessageType.DHT_STORE: {
        const payload = msg.payload as DhtStorePayload;
        let valueToStore = payload.value;
        const incomingClock = payload.lamport_clock || msg.lamport_clock || 0;
        const incomingVersion = payload.version || 1;

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
        } else {
          // Phân giải xung đột ghi đè dựa trên Lamport Logical Clocks & Version
          let existing = this.storage.get(payload.key);
          if (!existing && this.persistentStore) {
            existing = this.persistentStore.getDhtRecord(payload.key) || undefined;
          }
          if (existing && incomingClock > 0 && existing.lamport_clock && incomingClock < existing.lamport_clock) {
            this.logger.warn(
              "DHT",
              `Từ chối ghi đè dữ liệu cũ (Lamport Clock xung đột: nhận ${incomingClock} < hiện tại ${existing.lamport_clock}) cho key '${payload.key.substring(0, 10)}...'`
            );
            const ackMsg: BaseMessage<DhtStoreAckPayload> = {
              type: MessageType.DHT_STORE_ACK,
              message_id: crypto.randomUUID(),
              sender: this.localInfo.displayName,
              receiver: msg.sender,
              seq: 0,
              timestamp: Date.now(),
              lamport_clock: incomingClock,
              payload: {
                req_id: msg.message_id,
                key: payload.key,
                status: "OK",
                reason: "STALE_VERSION_IGNORED"
              },
              nonce: null,
              mac_or_signature: null
            };
            if (from) {
              await this.channel.sendMessage(from.ip, from.port, ackMsg);
            }
            return true;
          }
        }

        // Lưu bền vững vào cả RAM và SQLite
        this.saveToStorage(
          payload.key,
          valueToStore,
          payload.ttlMs || 3600000,
          payload.publisher,
          false,
          incomingClock,
          incomingVersion
        );

        if (valueToStore && valueToStore.type === "mailbox" && Array.isArray(valueToStore.messages)) {
          const recipientName = valueToStore.recipient || "unknown";
          const incomingCount = Array.isArray(payload.value?.messages) ? payload.value.messages.length : 0;
          if (incomingCount === 0) {
            this.logger.info(
              "DHT",
              `📬 [DISTRIBUTED MAILBOX] Đã dọn sạch hộp thư offline của '${recipientName}' theo yêu cầu từ '${payload.publisher}' (Key: ${payload.key.substring(0, 10)}...)`
            );
          } else {
            this.logger.info(
              "DHT",
              `📬 [DISTRIBUTED MAILBOX] Đã lưu trữ hộ ${valueToStore.messages.length} tin nhắn offline cho '${recipientName}' từ '${payload.publisher}' (Key: ${payload.key.substring(0, 10)}..., SQLite)`
            );
          }
        } else {
          this.logger.info("DHT", `Đã lưu trữ DHT key '${payload.key.substring(0, 10)}...' từ ${payload.publisher} (Đã bền vững vào SQLite)`);
        }

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
            value: entry.value,
            responderInfo: this.localInfo
          };
        } else {
          // Không có value: Trả về K node gần nhất với key (chỉ trả về các node khỏe mạnh)
          const closest = this.routingTable
            .getClosestNodes(payload.key, this.routingTable.kSize)
            .filter((c) => c.nodeId.toLowerCase() !== payload.senderNodeId.toLowerCase() && c.failedPings === 0);
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
            })),
            responderInfo: this.localInfo
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
        if (payload.responderInfo) {
          this.addOrUpdateContact(payload.responderInfo);
        }
        if (!payload.found && payload.nodes && payload.nodes.length > 0) {
          void this.verifyDiscoveredPeers(payload.nodes);
        }
        this.resolvePending(payload.req_id, payload);
        return true;
      }

      default:
        return false;
    }
  }

  private getEndpointKey(ip: string, port: number): string {
    return `${ip.trim().toLowerCase()}:${port}`;
  }

  private isSelfPeer(peer: { nodeId?: string; ip?: string; tcpPort?: number; publicKey?: string }): boolean {
    if (peer.nodeId && peer.nodeId.toLowerCase() === this.localNodeId.toLowerCase()) {
      return true;
    }
    if (peer.publicKey && this.publicKey && peer.publicKey === this.publicKey) {
      return true;
    }
    if (
      peer.ip &&
      peer.tcpPort &&
      peer.ip.trim().toLowerCase() === this.localInfo.ip.trim().toLowerCase() &&
      peer.tcpPort === this.localInfo.tcpPort
    ) {
      return true;
    }
    return false;
  }

  /**
   * Xác thực các peer nhận qua gossip (FIND_NODE_RESP / FIND_VALUE_RESP) bằng PING trực tiếp
   * trước khi thêm vào routing table để ngăn chặn peer chết hoặc định danh cũ quay lại.
   */
  private async verifyDiscoveredPeers(peers: PeerInfo[]): Promise<void> {
    for (const peer of peers) {
      if (this.isClosing) break;
      if (!peer.displayName || !peer.ip || !peer.tcpPort) continue;
      if (this.isSelfPeer(peer)) continue;

      const nodeId =
        peer.nodeId || (peer.publicKey ? generateNodeIdFromPublicKey(peer.publicKey) : generateNodeId(peer.displayName));
      const existingById = this.routingTable.get(nodeId);
      if (existingById && existingById.failedPings === 0) {
        continue;
      }

      const epKey = this.getEndpointKey(peer.ip, peer.tcpPort);
      const existingAtEndpoint = this.routingTable
        .getAll()
        .find((c) => this.getEndpointKey(c.ip, c.tcpPort) === epKey);
      if (
        existingAtEndpoint &&
        existingAtEndpoint.failedPings === 0 &&
        Date.now() - (existingAtEndpoint.lastSeen || 0) < 5000
      ) {
        continue;
      }

      if (this.verifyingEndpoints.has(epKey)) continue;
      this.verifyingEndpoints.add(epKey);
      try {
        const pong = await this.sendPing(peer.ip, peer.tcpPort);
        if (pong && this.isSelfPeer(pong)) {
          this.knownBootstrapPool.delete(epKey);
        }
      } finally {
        this.verifyingEndpoints.delete(epKey);
      }
    }
  }

  /**
   * Thêm hoặc cập nhật một peer đã xác thực trực tiếp vào routing table
   */
  public addOrUpdateContact(peer: PeerInfo): void {
    if (!peer.displayName || !peer.ip || !peer.tcpPort) return;

    // Chuẩn P2P: Node ID được sinh từ SHA1(PublicKey) thay vì SHA1(displayName)
    const nodeId = peer.nodeId || (peer.publicKey ? generateNodeIdFromPublicKey(peer.publicKey) : generateNodeId(peer.displayName));

    // Không thêm chính bản thân mình vào routing table (kiểm tra theo nodeId, publicKey hoặc cặp IP:Port)
    if (this.isSelfPeer({ ...peer, nodeId })) return;

    const epKey = this.getEndpointKey(peer.ip, peer.tcpPort);

    // Một endpoint ip:tcpPort tại một thời điểm chỉ thuộc về 1 Node ID đang chạy:
    // loại bỏ mọi Node ID cũ (stale/zombie) từng dùng chung ip:tcpPort này.
    const staleAtEndpoint = this.routingTable
      .getAll()
      .filter(
        (c) =>
          this.getEndpointKey(c.ip, c.tcpPort) === epKey &&
          c.nodeId.toLowerCase() !== nodeId.toLowerCase()
      );

    for (const stale of staleAtEndpoint) {
      if (this.routingTable.remove(stale.nodeId)) {
        this.logger.warn(
          "DHT",
          `[DHT REPLACED] Thay thế định danh cũ '${stale.displayName}' (${stale.ip}:${stale.tcpPort}) [ID: ${stale.nodeId.substring(0, 8)}...] bằng định danh mới [ID: ${nodeId.substring(0, 8)}...].`
        );
        this.emitPeerLeft(stale);
      }
    }

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
    this.knownBootstrapPool.set(epKey, { ip: peer.ip, port: peer.tcpPort });

    const isExisting = !!this.routingTable.get(nodeId);
    const result = this.routingTable.addOrUpdate(contact);

    if (
      result &&
      (result.status === "ADDED" ||
        result.status === "EVICTED_AND_ADDED" ||
        (!isExisting && result.status === "UPDATED"))
    ) {
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
    const res = await this.sendFindNodeInternal(ip, port, targetNodeId);
    return res.nodes;
  }

  private async sendFindNodeInternal(
    ip: string,
    port: number,
    targetNodeId: string
  ): Promise<{ ok: boolean; nodes: PeerInfo[]; responderInfo?: PeerInfo }> {
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
    if (!sent) return { ok: false, nodes: [] };

    try {
      const resp = await this.waitForResponse<DhtFindNodeRespPayload | PeerInfo[]>(msgId, this.rpcTimeoutMs);
      if (Array.isArray(resp)) {
        return { ok: true, nodes: resp };
      }
      return { ok: true, nodes: resp?.nodes || [], responderInfo: resp?.responderInfo };
    } catch {
      return { ok: false, nodes: [] };
    }
  }

  /**
   * Giải thuật tìm kiếm lặp (Iterative Node Lookup) theo chuẩn Kademlia
   * Truy vấn lặp qua các node gần nhất để hội tụ về targetNodeId.
   */
  public async iterativeFindNode(targetNodeId: string): Promise<PeerInfo[]> {
    const targetNorm = targetNodeId.toLowerCase();
    const queriedIds = new Set<string>();
    const queriedEndpoints = new Set<string>();
    const respondedEndpoints = new Set<string>();
    queriedIds.add(this.localNodeId.toLowerCase());
    queriedEndpoints.add(this.getEndpointKey(this.localInfo.ip, this.localInfo.tcpPort));

    // Lấy shortlist ban đầu từ routing table
    let shortlist = this.routingTable.getClosestNodes(targetNorm, this.routingTable.kSize);
    if (shortlist.length === 0) return [];

    let hasCloser = true;
    let rounds = 0;
    const maxRounds = 8;
    const discoveredExtras: PeerInfo[] = [];

    while (hasCloser && rounds < maxRounds) {
      rounds++;
      // Chọn ra tối đa alpha node chưa được truy vấn gần target nhất
      const unqueried = shortlist.filter(
        (c) =>
          !queriedIds.has(c.nodeId.toLowerCase()) &&
          !queriedEndpoints.has(this.getEndpointKey(c.ip, c.tcpPort))
      );
      if (unqueried.length === 0) break;

      const candidates = unqueried.slice(0, this.alpha);
      for (const c of candidates) {
        queriedIds.add(c.nodeId.toLowerCase());
        queriedEndpoints.add(this.getEndpointKey(c.ip, c.tcpPort));
      }

      // Gửi FIND_NODE đồng thời tới các ứng viên (alpha concurrency)
      const promises = candidates.map((c) => this.sendFindNodeInternal(c.ip, c.tcpPort, targetNorm));
      const results = await Promise.all(promises);

      let foundNewNode = false;
      const deadCandidateIds = new Set<string>();

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const res = results[i];
        const epKey = this.getEndpointKey(candidate.ip, candidate.tcpPort);

        if (!res.ok) {
          deadCandidateIds.add(candidate.nodeId.toLowerCase());
          continue;
        }

        if (res.responderInfo && this.isSelfPeer(res.responderInfo)) {
          deadCandidateIds.add(candidate.nodeId.toLowerCase());
          this.knownBootstrapPool.delete(epKey);
          continue;
        }

        respondedEndpoints.add(epKey);

        if (res.responderInfo) {
          const realId =
            res.responderInfo.nodeId ||
            (res.responderInfo.publicKey
              ? generateNodeIdFromPublicKey(res.responderInfo.publicKey)
              : generateNodeId(res.responderInfo.displayName));
          queriedIds.add(realId.toLowerCase());
          candidate.nodeId = realId;
          candidate.displayName = res.responderInfo.displayName;
        } else if (!this.routingTable.get(candidate.nodeId)) {
          // Node phản hồi không kèm responderInfo (phiên bản cũ): ping xác thực trước khi thêm
          const pong = await this.sendPing(candidate.ip, candidate.tcpPort);
          if (!pong || this.isSelfPeer(pong)) {
            deadCandidateIds.add(candidate.nodeId.toLowerCase());
            continue;
          }
        }

        for (const peer of res.nodes) {
          if (this.isSelfPeer(peer)) continue;
          const pNodeId =
            peer.nodeId ||
            (peer.publicKey ? generateNodeIdFromPublicKey(peer.publicKey) : generateNodeId(peer.displayName));
          if (pNodeId.toLowerCase() === this.localNodeId.toLowerCase()) continue;

          const peerEp = this.getEndpointKey(peer.ip, peer.tcpPort);
          // Bỏ qua gossip trùng lặp với endpoint vừa được truy vấn trực tiếp trong phiên lookup này
          if (queriedEndpoints.has(peerEp)) continue;

          // Nếu chưa có nodeId hoặc endpoint này trong shortlist thì thêm vào để round sau kiểm tra trực tiếp
          const alreadyInShortlist = shortlist.some(
            (c) =>
              c.nodeId.toLowerCase() === pNodeId.toLowerCase() ||
              this.getEndpointKey(c.ip, c.tcpPort) === peerEp
          );
          if (!alreadyInShortlist) {
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

      if (deadCandidateIds.size > 0) {
        shortlist = shortlist.filter((c) => !deadCandidateIds.has(c.nodeId.toLowerCase()));
      }

      // Sắp xếp lại shortlist theo khoảng cách XOR tới target
      shortlist.sort((a, b) => {
        const da = xorDistance(a.nodeId, targetNorm);
        const db = xorDistance(b.nodeId, targetNorm);
        return da < db ? -1 : da > db ? 1 : 0;
      });

      // Giới hạn K nodes tốt nhất, các node bị loại vẫn xác thực nền nếu chưa có trong routingTable
      if (shortlist.length > this.routingTable.kSize) {
        discoveredExtras.push(...shortlist.slice(this.routingTable.kSize));
        shortlist = shortlist.slice(0, this.routingTable.kSize);
      }

      const stillUnqueried = shortlist.some(
        (c) =>
          !queriedIds.has(c.nodeId.toLowerCase()) &&
          !queriedEndpoints.has(this.getEndpointKey(c.ip, c.tcpPort))
      );
      if (!foundNewNode && !stillUnqueried) {
        hasCloser = false;
      }
    }

    if (discoveredExtras.length > 0) {
      void this.verifyDiscoveredPeers(discoveredExtras);
    }

    // Chỉ trả về các node đã xác thực trực tiếp hoặc đã tồn tại trong routingTable
    const verifiedShortlist = shortlist.filter(
      (c) =>
        respondedEndpoints.has(this.getEndpointKey(c.ip, c.tcpPort)) ||
        !!this.routingTable.get(c.nodeId)
    );

    return verifiedShortlist.map((c) => ({
      displayName: c.displayName,
      ip: c.ip,
      tcpPort: c.tcpPort,
      lastSeen: c.lastSeen,
      nodeId: c.nodeId
    }));
  }

  /**
   * Lưu trữ cặp key-value lên K node gần key nhất trong mạng DHT
   * Đồng thời lưu bền vững vào SQLite với cờ isLocalPublished = true.
   * Hỗ trợ Lamport Logical Clock & Version cho phân giải xung đột nhân quả.
   */
  public async store(
    key: string,
    value: any,
    ttlMs: number = 3600000,
    lamportClock: number = 0,
    version: number = 1
  ): Promise<number> {
    // 1. Lưu bản sao trên chính mình (RAM + SQLite, đánh dấu sở hữu bản quyền dữ liệu)
    this.saveToStorage(
      key,
      value,
      ttlMs,
      this.localInfo.displayName,
      true,
      lamportClock,
      version
    );

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
        lamport_clock: lamportClock,
        payload: {
          key,
          value,
          ttlMs,
          publisher: this.localInfo.displayName,
          publisherNodeId: this.localNodeId,
          lamport_clock: lamportClock,
          version
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
   * Truy vấn Distributed Mailbox trên mạng DHT:
   * Luôn hỏi các node lân cận trên mạng và hợp nhất (Set-Union) các tin nhắn nhận được,
   * tránh bị kẹt bởi bản ghi mailbox rỗng cũ lưu cục bộ trong SQLite.
   */
  public async fetchMailbox(mailboxKey: string): Promise<{
    found: boolean;
    foundRemote: boolean;
    recipient?: string;
    messages: MailboxMessage[];
  }> {
    const mergedMap = new Map<string, MailboxMessage>();
    let recipient: string | undefined;
    let foundRemote = false;

    const closest = this.routingTable.getClosestNodes(mailboxKey, this.routingTable.kSize);
    if (closest.length > 0) {
      const results = await Promise.all(
        closest.map(async (contact) => {
          const msgId = crypto.randomUUID();
          const req: BaseMessage<DhtFindValuePayload> = {
            type: MessageType.DHT_FIND_VALUE,
            message_id: msgId,
            sender: this.localInfo.displayName,
            receiver: contact.displayName,
            seq: 0,
            timestamp: Date.now(),
            payload: {
              key: mailboxKey,
              senderNodeId: this.localNodeId,
              senderInfo: this.localInfo
            },
            nonce: null,
            mac_or_signature: null
          };

          const sent = await this.channel.sendMessage(contact.ip, contact.tcpPort, req);
          if (!sent) return null;

          try {
            return await this.waitForResponse<DhtFindValueRespPayload>(msgId, this.rpcTimeoutMs);
          } catch {
            return null;
          }
        })
      );

      for (const resp of results) {
        if (resp && resp.found && resp.value && resp.value.type === "mailbox" && Array.isArray(resp.value.messages)) {
          foundRemote = true;
          if (!recipient && resp.value.recipient) {
            recipient = resp.value.recipient;
          }
          for (const m of resp.value.messages as MailboxMessage[]) {
            if (m && m.message_id) {
              mergedMap.set(m.message_id, m);
            }
          }
        }
      }
    }

    if (!foundRemote) {
      let local = this.storage.get(mailboxKey);
      if (!local && this.persistentStore) {
        local = this.persistentStore.getDhtRecord(mailboxKey) || undefined;
      }
      if (
        local &&
        local.expiresAt > Date.now() &&
        local.value &&
        local.value.type === "mailbox" &&
        Array.isArray(local.value.messages)
      ) {
        if (!recipient && local.value.recipient) {
          recipient = local.value.recipient;
        }
        for (const m of local.value.messages as MailboxMessage[]) {
          if (m && m.message_id) {
            mergedMap.set(m.message_id, m);
          }
        }
      }
    }

    return {
      found: foundRemote || mergedMap.size > 0,
      foundRemote,
      recipient,
      messages: Array.from(mergedMap.values())
    };
  }

  /**
   * Lưu một tin nhắn offline vào Distributed Mailbox của người nhận trên DHT.
   * Dữ liệu được replicate trên K node gần hash(receiver) nhất.
   */
  public async depositMailbox(
    mailboxKey: string,
    message: MailboxMessage,
    ttlMs: number = 24 * 3600 * 1000
  ): Promise<boolean> {
    // 1. Lấy mailbox hiện tại trên mạng DHT (hoặc local nếu mạng chưa có node nào khác)
    const current = await this.fetchMailbox(mailboxKey);
    const messages: MailboxMessage[] = [...current.messages];

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
    // Không lưu bản ghi mailbox rỗng cục bộ của chính mình để tránh che mất truy vấn mạng ở lần khởi động sau
    this.deleteFromStorage(mailboxKey);
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
      const isSameEndpoint =
        existing.found &&
        existing.value &&
        existing.value.ip &&
        existing.value.tcpPort &&
        this.getEndpointKey(existing.value.ip, existing.value.tcpPort) ===
          this.getEndpointKey(this.localInfo.ip, this.localInfo.tcpPort);

      if (
        existing.found &&
        existing.value &&
        existing.value.nodeId &&
        existing.value.nodeId.toLowerCase() !== this.localNodeId.toLowerCase() &&
        !isSameEndpoint
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

    this.maintenanceTimer = setInterval(() => {
      if (this.isClosing || this.maintenancePromise) return;
      this.runMaintenance().catch(() => {});
    }, this.pingIntervalMs);
  }

  public async runMaintenance(): Promise<void> {
    while (this.maintenancePromise) {
      await this.maintenancePromise;
    }
    if (this.isClosing) return;

    const run = this.executeMaintenance();
    this.maintenancePromise = run;
    try {
      await run;
    } finally {
      if (this.maintenancePromise === run) {
        this.maintenancePromise = null;
      }
    }
  }

  private async executeMaintenance(): Promise<void> {
    const contacts = this.routingTable.getAll();

    await Promise.all(
      contacts.map(async (contact) => {
        if (this.isClosing) return;

        const pong = await this.sendPing(contact.ip, contact.tcpPort);
        if (this.isClosing) return;

        if (pong) {
          const epKey = this.getEndpointKey(contact.ip, contact.tcpPort);
          if (this.isSelfPeer(pong)) {
            this.knownBootstrapPool.delete(epKey);
            if (this.routingTable.remove(contact.nodeId)) {
              this.emitPeerLeft(contact);
            }
            return;
          }

          const pongNodeId = pong.nodeId?.toLowerCase();
          const expectedNodeId = contact.nodeId.toLowerCase();
          if (pongNodeId && pongNodeId !== expectedNodeId) {
            // Endpoint hiện do Node ID khác nắm giữ -> loại bỏ Node ID cũ ngay lập tức
            if (this.routingTable.remove(contact.nodeId)) {
              this.logger.warn(
                "DHT",
                `[DHT LIVENESS] Peer '${contact.displayName}' (${contact.ip}:${contact.tcpPort}) đã đổi Node ID (${expectedNodeId.substring(0, 8)}... -> ${pongNodeId.substring(0, 8)}...). Xóa định danh cũ.`
              );
              this.emitPeerLeft(contact);
            }
            return;
          }

          contact.failedPings = 0;
          contact.lastSeen = Date.now();
        } else {
          contact.failedPings += 1;
          // Nếu 2 lần liên tiếp không nhận được PONG -> Coi như peer đã ngắt kết nối
          if (contact.failedPings >= 2) {
            if (this.routingTable.remove(contact.nodeId)) {
              this.logger.warn(
                "DHT",
                `[DHT LIVENESS] Peer '${contact.displayName}' không phản hồi sau ${contact.failedPings} lần ping. Đánh dấu OFFLINE.`
              );
              this.emitPeerLeft(contact);
            }
          }
        }
      })
    );

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
    while (this.healingPromise) {
      await this.healingPromise;
    }
    if (this.isClosing) return false;

    const run = this.executeHealPartition();
    this.healingPromise = run;
    try {
      return await run;
    } finally {
      if (this.healingPromise === run) {
        this.healingPromise = null;
      }
    }
  }

  private async executeHealPartition(): Promise<boolean> {
    if (this.isClosing) return false;

    const activeContacts = this.routingTable.getAll();
    const missingCandidates: Array<{ ip: string; port: number }> = [];

    // 1. Kiểm tra bootstrap peers được cấu hình ban đầu
    for (const bp of this.bootstrapPeers) {
      if (
        bp.ip.trim().toLowerCase() === this.localInfo.ip.trim().toLowerCase() &&
        bp.port === this.localInfo.tcpPort
      ) {
        continue;
      }
      const isActive = activeContacts.some(
        (c) => this.getEndpointKey(c.ip, c.tcpPort) === this.getEndpointKey(bp.ip, bp.port)
      );
      if (!isActive) {
        missingCandidates.push(bp);
      }
    }

    // 2. Kiểm tra known peers trong pool lịch sử (cho phép seed node cũng hàn gắn được)
    for (const kp of this.knownBootstrapPool.values()) {
      if (
        kp.ip.trim().toLowerCase() === this.localInfo.ip.trim().toLowerCase() &&
        kp.port === this.localInfo.tcpPort
      ) {
        continue;
      }
      const kpKey = this.getEndpointKey(kp.ip, kp.port);
      const isActive = activeContacts.some((c) => this.getEndpointKey(c.ip, c.tcpPort) === kpKey);
      const isAlready = missingCandidates.some((m) => this.getEndpointKey(m.ip, m.port) === kpKey);
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
        if (this.isSelfPeer(pong)) {
          this.knownBootstrapPool.delete(this.getEndpointKey(candidate.ip, candidate.port));
          continue;
        }
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

    this.healingTimer = setInterval(() => {
      if (this.isClosing || this.healingPromise) return;
      this.healPartition().catch(() => {
        // Tránh unhandled rejection trong background interval
      });
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

