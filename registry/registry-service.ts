/**
 * Dịch vụ Registry (Mock KDC - Giai đoạn 1)
 * Quản lý danh sách Peer Online, Heartbeat, Phát hiện rớt mạng và thông báo discovery.
 */

import net from "node:net";
import {
  BaseMessage,
  MessageType,
  PeerInfo,
  RegisterPayload,
  RegisterAckPayload,
  HeartbeatAckPayload,
  PeerLeftPayload
} from "../common/protocol.js";
import { encodeFrame } from "../common/framing.js";
import { Logger } from "../common/logger.js";
import { config } from "../common/config.js";

interface ActivePeerEntry {
  info: PeerInfo;
  socket: net.Socket;
  lastHeartbeat: number;
}

export class RegistryService {
  private peers: Map<string, ActivePeerEntry> = new Map();
  private timeoutTimer: NodeJS.Timeout | null = null;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Bắt đầu tiến trình kiểm tra timeout định kỳ
   */
  public startHeartbeatMonitor(): void {
    const interval = config.registry.checkIntervalMs;
    this.timeoutTimer = setInterval(() => {
      this.checkHeartbeatTimeouts();
    }, interval);
  }

  public stopHeartbeatMonitor(): void {
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /**
   * Đăng ký một Peer mới vào hệ thống
   */
  public register(
    displayName: string,
    payload: RegisterPayload,
    socket: net.Socket
  ): { success: boolean; ack: BaseMessage<RegisterAckPayload> } {
    const now = Date.now();

    // 1. Kiểm tra trùng tên hiển thị
    const existing = this.peers.get(displayName);
    if (existing && !existing.socket.destroyed) {
      this.logger.warn(
        "PROTOCOL",
        `Đăng ký bị từ chối: Tên '${displayName}' đã tồn tại và đang online.`,
        { displayName, requestedIp: payload.ip, requestedPort: payload.tcpPort }
      );

      const rejectAck: BaseMessage<RegisterAckPayload> = {
        type: MessageType.REGISTER_ACK,
        message_id: crypto.randomUUID(),
        sender: "REGISTRY",
        receiver: displayName,
        seq: 0,
        timestamp: now,
        payload: {
          status: "REJECTED",
          reason: `Tên '${displayName}' đã được sử dụng bởi một peer khác đang online.`,
          peers: []
        },
        nonce: null,
        mac_or_signature: null
      };

      return { success: false, ack: rejectAck };
    }

    // 2. Lưu thông tin Peer vào bảng
    const peerInfo: PeerInfo = {
      displayName,
      ip: payload.ip,
      tcpPort: payload.tcpPort,
      lastSeen: now
    };

    this.peers.set(displayName, {
      info: peerInfo,
      socket,
      lastHeartbeat: now
    });

    this.logger.info(
      "PROTOCOL",
      `Peer '${displayName}' đăng ký thành công (${peerInfo.ip}:${peerInfo.tcpPort}). Tổng số peer online: ${this.peers.size}`,
      peerInfo,
      { peer: displayName, direction: "IN", messageType: MessageType.REGISTER }
    );

    // 3. Chuẩn bị danh sách tất cả các peer đang online để trả về
    const onlinePeersList = this.getOnlinePeers();

    const okAck: BaseMessage<RegisterAckPayload> = {
      type: MessageType.REGISTER_ACK,
      message_id: crypto.randomUUID(),
      sender: "REGISTRY",
      receiver: displayName,
      seq: 0,
      timestamp: now,
      payload: {
        status: "OK",
        peers: onlinePeersList
      },
      nonce: null,
      mac_or_signature: null
    };

    // 4. Phát sóng (Broadcast) thông báo PEER_JOINED tới tất cả các peer khác
    this.broadcast(
      {
        type: MessageType.PEER_JOINED,
        message_id: crypto.randomUUID(),
        sender: "REGISTRY",
        receiver: "BROADCAST",
        seq: 0,
        timestamp: now,
        payload: peerInfo,
        nonce: null,
        mac_or_signature: null
      },
      displayName // Không gửi lại cho chính người vừa đăng ký
    );

    return { success: true, ack: okAck };
  }

  /**
   * Xử lý Heartbeat từ Peer
   */
  public handleHeartbeat(displayName: string): BaseMessage<HeartbeatAckPayload> | null {
    const entry = this.peers.get(displayName);
    const now = Date.now();

    if (!entry) {
      this.logger.warn("PROTOCOL", `Nhận heartbeat từ peer chưa đăng ký: '${displayName}'`);
      return null;
    }

    entry.lastHeartbeat = now;
    entry.info.lastSeen = now;

    return {
      type: MessageType.HEARTBEAT_ACK,
      message_id: crypto.randomUUID(),
      sender: "REGISTRY",
      receiver: displayName,
      seq: 0,
      timestamp: now,
      payload: { serverTime: now },
      nonce: null,
      mac_or_signature: null
    };
  }

  /**
   * Hủy đăng ký một Peer (chủ động thoát hoặc do socket đóng)
   */
  public unregister(displayName: string, reason = "Peer disconnected"): void {
    const entry = this.peers.get(displayName);
    if (!entry) return;

    this.peers.delete(displayName);
    this.logger.info("PROTOCOL", `Peer '${displayName}' đã rời mạng (${reason}). Còn lại: ${this.peers.size} peer.`);

    // Broadcast PEER_LEFT tới các peer còn lại
    this.broadcast({
      type: MessageType.PEER_LEFT,
      message_id: crypto.randomUUID(),
      sender: "REGISTRY",
      receiver: "BROADCAST",
      seq: 0,
      timestamp: Date.now(),
      payload: { displayName, reason },
      nonce: null,
      mac_or_signature: null
    });
  }

  /**
   * Định kỳ kiểm tra timeout heartbeat
   * LƯU Ý HỆ THỐNG PHÂN TÁN: Trong hệ thống phân tán bất đồng bộ (Asynchronous Distributed System),
   * cơ chế Timeout Failure Detector không thể phân biệt chính xác giữa việc:
   * (1) Tiến trình thực sự bị sập (Crash-stop failure)
   * (2) Tiến trình vẫn sống nhưng mạng bị chậm/nghẽn gói tin (Slow network / Partition).
   */
  public checkHeartbeatTimeouts(): void {
    const now = Date.now();
    const timeoutMs = config.registry.heartbeatTimeoutMs;

    for (const [displayName, entry] of this.peers.entries()) {
      const elapsed = now - entry.lastHeartbeat;
      if (elapsed > timeoutMs) {
        this.logger.warn(
          "PROTOCOL",
          `Phát hiện timeout peer '${displayName}' (quá ${elapsed}ms không có heartbeat). Đánh dấu offline. ` +
          `[Ghi chú phân tán: Timeout không phân biệt được crash thật hay mạng chậm]`,
          { displayName, elapsed, timeoutMs }
        );

        // Hủy đăng ký và đóng socket nếu còn mở
        this.unregister(displayName, `Heartbeat timeout (${elapsed}ms)`);
        try {
          if (!entry.socket.destroyed) {
            entry.socket.destroy();
          }
        } catch (e) {
          // Bỏ qua lỗi đóng socket
        }
      }
    }
  }

  /**
   * Lấy danh sách thông tin các peer đang online
   */
  public getOnlinePeers(): PeerInfo[] {
    return Array.from(this.peers.values()).map((p) => p.info);
  }

  /**
   * Tìm thông tin peer theo tên hiển thị
   */
  public getPeer(displayName: string): PeerInfo | null {
    const entry = this.peers.get(displayName);
    return entry ? entry.info : null;
  }

  /**
   * Phát sóng một thông điệp tới tất cả các peer đang kết nối
   */
  public broadcast(message: BaseMessage, excludePeerName?: string): void {
    const frame = encodeFrame(message);
    for (const [name, entry] of this.peers.entries()) {
      if (name === excludePeerName) continue;
      try {
        if (!entry.socket.destroyed) {
          entry.socket.write(frame);
        }
      } catch (err: any) {
        this.logger.error("NETWORK", `Lỗi khi broadcast tới peer '${name}': ${err.message}`);
      }
    }
  }

  /**
   * Dọn dẹp khi tắt Registry
   */
  public closeAll(): void {
    this.stopHeartbeatMonitor();
    for (const [, entry] of this.peers.entries()) {
      try {
        entry.socket.destroy();
      } catch (e) {}
    }
    this.peers.clear();
  }
}

