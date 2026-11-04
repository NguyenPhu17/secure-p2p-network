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
  PeerLeftPayload
} from "../common/protocol.js";
import { IChannel } from "../common/channel.js";
import { PlainChannel } from "./channel/plain-channel.js";
import { MessageStore, MessageRecord } from "./db/message-store.js";
import { FileSender, FileTransferProgress } from "./transfer/file-sender.js";
import { FileReceiver } from "./transfer/file-receiver.js";
import { Logger } from "../common/logger.js";
import { config } from "../common/config.js";
import { FrameDecoder, encodeFrame } from "../common/framing.js";

export interface PeerControllerOptions {
  displayName: string;
  tcpPort: number;
  ip?: string;
  registryHost?: string;
  registryPort?: number;
  dbPath?: string;
  downloadDir?: string;
}

export type UIEventCallback = (event: string, data: any) => void;

export class PeerController {
  public readonly displayName: string;
  public readonly tcpPort: number;
  public readonly ip: string;
  private registryHost: string;
  private registryPort: number;

  private logger: Logger;
  private store: MessageStore;
  private channel: IChannel;
  private fileSender: FileSender;
  private fileReceiver: FileReceiver;

  // Socket kết nối tới Registry để đăng ký và heartbeat
  private registrySocket: net.Socket | null = null;
  private registryDecoder = new FrameDecoder();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Bảng theo dõi các peer đang online trong bộ nhớ (Tối ưu RAM)
  private onlinePeers: Map<string, PeerInfo> = new Map();

  // Callbacks thông báo tới UI Bridge
  private uiListeners: UIEventCallback[] = [];
  private isClosing = false;

  constructor(opts: PeerControllerOptions) {
    this.displayName = opts.displayName;
    this.tcpPort = opts.tcpPort;
    this.ip = opts.ip || "127.0.0.1";
    this.registryHost = opts.registryHost || config.registry.host;
    this.registryPort = opts.registryPort || config.registry.port;

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
  }

  public getLogger(): Logger {
    return this.logger;
  }

  public getStore(): MessageStore {
    return this.store;
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
    this.logger.info("SYSTEM", `Khởi động Peer Node '${this.displayName}' trên cổng TCP ${this.tcpPort}...`);

    // 1. Khởi động P2P Channel
    await this.channel.init();

    // 2. Lắng nghe tin nhắn P2P từ các peer khác
    this.channel.onReceive((msg, from) => {
      this.handleIncomingP2PMessage(msg, from);
    });

    // 3. Kết nối và Đăng ký với Registry (Mock KDC)
    await this.connectAndRegisterToRegistry();
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
   * Xử lý gói tin P2P nhận được từ một Peer khác
   */
  private async handleIncomingP2PMessage(msg: BaseMessage, from?: { ip: string; port: number }): Promise<void> {
    this.logger.info(
      "PROTOCOL",
      `Nhận [${msg.type}] từ peer '${msg.sender}' (seq: ${msg.seq})`,
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
          mac_or_signature: msg.mac_or_signature
        };

        // Lưu vào SQLite với cơ chế Deduplication
        const { isDuplicate } = this.store.saveMessage(record);

        // Luôn gửi lại CHAT_ACK để bên gửi biết tin đã tới (kể cả khi nhận trùng lặp)
        await this.sendChatAck(msg.sender, msg.message_id);

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
        this.store.updateMessageStatus(payload.ack_message_id, "delivered");
        this.logger.info("PROTOCOL", `Tin nhắn ${payload.ack_message_id} đã được ACK (delivered).`);
        this.emitUI("MESSAGE_STATUS_UPDATE", {
          message_id: payload.ack_message_id,
          status: "delivered"
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
          created_at: Date.now()
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
   * Gửi phản hồi CHAT_ACK cho bên gửi
   */
  private async sendChatAck(targetPeer: string, originalMessageId: string): Promise<void> {
    const peer = this.onlinePeers.get(targetPeer);
    if (!peer) return;

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

    await this.channel.sendMessage(peer.ip, peer.tcpPort, ackMsg);
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

    // 2. Thử gửi qua TCP tới peer đối tác
    await this.attemptSendMessage(record);

    return record;
  }

  /**
   * Thử gửi một tin nhắn đi (hỗ trợ cả tin mới và gửi lại tin pending)
   */
  private async attemptSendMessage(record: MessageRecord): Promise<boolean> {
    const peer = this.onlinePeers.get(record.receiver);

    if (!peer) {
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

    const sent = await this.channel.sendMessage(peer.ip, peer.tcpPort, chatMsg);
    if (sent) {
      this.store.updateMessageStatus(record.message_id, "sent");
      record.status = "sent";
      this.emitUI("MESSAGE_STATUS_UPDATE", {
        message_id: record.message_id,
        status: "sent"
      });
      return true;
    } else {
      this.logger.warn("NETWORK", `Gửi tin ${record.message_id} thất bại. Giữ trạng thái pending.`);
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
