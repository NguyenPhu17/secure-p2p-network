/**
 * PlainChannel - Cài đặt Channel truyền Plaintext qua Raw TCP Sockets (Giai đoạn 1)
 *
 * Mọi kết nối P2P trực tiếp giữa các Peer (gửi tin nhắn, chunk file) đều đi qua lớp này.
 * Không thực hiện mã hóa hoặc bọc khóa tại giai đoạn này.
 */

import net from "node:net";
import { IChannel, MessageHandler } from "../../common/channel.js";
import { BaseMessage } from "../../common/protocol.js";
import { encodeFrame, FrameDecoder } from "../../common/framing.js";
import { Logger } from "../../common/logger.js";

export class PlainChannel implements IChannel {
  private server: net.Server | null = null;
  private receiveHandler: MessageHandler | null = null;
  // Connection Pool cho các socket gửi đi: key = "ip:port"
  private activeSockets: Map<string, net.Socket> = new Map();
  private pendingConnections: Map<string, Promise<net.Socket>> = new Map();
  // Quản lý các socket kết nối đến để có thể đóng tức thì khi shutdown
  private incomingSockets: Set<net.Socket> = new Set();
  // Giả lập rớt mạng / firewall theo endpoint: "ip:port"
  private blockedEndpoints: Set<string> = new Set();

  constructor(
    private listenHost: string,
    private listenPort: number,
    private logger: Logger
  ) {}

  public simulateBlockEndpoint(ip: string, port: number, blocked: boolean = true): void {
    const key = `${ip}:${port}`;
    if (blocked) {
      this.blockedEndpoints.add(key);
      const sock = this.activeSockets.get(key);
      if (sock) {
        sock.destroy();
        this.activeSockets.delete(key);
      }
    } else {
      this.blockedEndpoints.delete(key);
    }
  }

  public async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.incomingSockets.add(socket);
        const remoteIp = socket.remoteAddress || "unknown";
        const remotePort = socket.remotePort || 0;
        const decoder = new FrameDecoder();

        socket.on("data", (chunk: Buffer) => {
          decoder.push(
            chunk,
            (msg: BaseMessage) => {
              if (this.receiveHandler) {
                this.receiveHandler(msg, { ip: remoteIp, port: remotePort });
              }
            },
            (err: Error) => {
              this.logger.error("PROTOCOL", `Lỗi giải mã frame từ peer [${remoteIp}:${remotePort}]: ${err.message}`);
            }
          );
        });

        socket.on("error", (err: Error) => {
          this.logger.warn("NETWORK", `Lỗi incoming socket [${remoteIp}:${remotePort}]: ${err.message}`);
        });

        socket.on("close", () => {
          this.incomingSockets.delete(socket);
          decoder.reset();
        });
      });

      this.server.on("error", (err: Error) => {
        reject(err);
      });

      this.server.listen(this.listenPort, "0.0.0.0", () => {
        this.logger.info("NETWORK", `PlainChannel P2P Server đang lắng nghe tại 0.0.0.0:${this.listenPort} (quảng bá IP: ${this.listenHost})`);
        resolve();
      });
    });
  }

  public async sendMessage(targetIp: string, targetPort: number, message: BaseMessage): Promise<boolean> {
    const key = `${targetIp}:${targetPort}`;
    if (this.blockedEndpoints.has(key)) {
      return false;
    }

    let socket = this.activeSockets.get(key);

    if (!socket || socket.destroyed) {
      try {
        let pending = this.pendingConnections.get(key);
        if (!pending) {
          pending = this.connectToPeer(targetIp, targetPort).finally(() => {
            this.pendingConnections.delete(key);
          });
          this.pendingConnections.set(key, pending);
        }
        socket = await pending;
        this.activeSockets.set(key, socket);
      } catch (err: any) {
        this.logger.warn("NETWORK", `Không thể kết nối TCP tới peer ${key}: ${err.message}`);
        return false;
      }
    }

    try {
      const frame = encodeFrame(message);
      return new Promise((resolve) => {
        socket!.write(frame, (err) => {
          if (err) {
            this.logger.error("NETWORK", `Lỗi khi ghi socket tới ${key}: ${err.message}`);
            socket!.destroy();
            this.activeSockets.delete(key);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    } catch (err: any) {
      this.logger.error("NETWORK", `Lỗi đóng gói frame gửi tới ${key}: ${err.message}`);
      return false;
    }
  }

  private connectToPeer(ip: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.connect(port, ip, () => {
        this.logger.info("NETWORK", `Đã thiết lập kết nối TCP P2P tới ${ip}:${port}`);
        resolve(socket);
      });

      socket.on("error", (err) => {
        this.activeSockets.delete(`${ip}:${port}`);
        reject(err);
      });

      socket.on("close", () => {
        this.activeSockets.delete(`${ip}:${port}`);
      });
    });
  }

  public onReceive(handler: MessageHandler): void {
    this.receiveHandler = handler;
  }

  public isSecure(): boolean {
    return false; // Giai đoạn 1: Plaintext
  }

  public async close(): Promise<void> {
    for (const [, sock] of this.activeSockets.entries()) {
      try {
        sock.destroy();
      } catch (e) {}
    }
    this.activeSockets.clear();

    for (const sock of this.incomingSockets) {
      try {
        sock.destroy();
      } catch (e) {}
    }
    this.incomingSockets.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }
}
