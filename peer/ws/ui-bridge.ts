/**
 * UIBridge - WebSocket Server làm cầu nối giữa Peer Backend và React UI
 * Lắng nghe kết nối WebSocket từ giao diện trình duyệt trên localhost.
 */

import { WebSocketServer, WebSocket } from "ws";
import { PeerController } from "../peer-controller.js";
import { Logger, LogEntry } from "../../common/logger.js";

export class UIBridge {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();

  constructor(
    private peerController: PeerController,
    private uiPort: number,
    private logger: Logger
  ) {}

  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.uiPort }, () => {
        this.logger.info("SYSTEM", `UIBridge WebSocket Server đang chạy tại ws://127.0.0.1:${this.uiPort}`);
        resolve();
      });

      this.wss.on("connection", (ws: WebSocket) => {
        this.clients.add(ws);
        this.logger.info("NETWORK", "React UI đã kết nối tới WebSocket Bridge.");

        // Gửi trạng thái ban đầu ngay khi UI vừa kết nối
        this.sendToClient(ws, {
          event: "INITIAL_STATE",
          data: {
            me: this.peerController.displayName,
            nodeId: this.peerController.getNodeId(),
            tcpPort: this.peerController.tcpPort,
            discoveryMode: this.peerController.discoveryMode,
            peers: this.peerController.getOnlinePeers(),
            channelStatus: "Plaintext (Chưa mã hóa - DHT Pure P2P)",
            logs: this.logger.getRecentLogs()
          }
        });

        ws.on("message", async (rawData: Buffer | string) => {
          try {
            const cmd = JSON.parse(rawData.toString());
            await this.handleUICommand(ws, cmd);
          } catch (err: any) {
            this.logger.error("SYSTEM", `Lỗi xử lý lệnh từ UI: ${err.message}`);
          }
        });

        ws.on("close", () => {
          this.clients.delete(ws);
          this.logger.info("NETWORK", "React UI đã ngắt kết nối WebSocket.");
        });

        ws.on("error", (err) => {
          this.logger.warn("NETWORK", `Lỗi kết nối UI WebSocket: ${err.message}`);
        });
      });

      // Lắng nghe sự kiện từ PeerController để phát lên UI
      this.peerController.onUIEvent((event, data) => {
        this.broadcast({ event, data });
      });

      // Lắng nghe log thời gian thực để phát lên Panel Protocol Logs của UI
      this.logger.onLog((entry: LogEntry) => {
        this.broadcast({ event: "PROTOCOL_LOG", data: entry });
      });
    });
  }

  private async handleUICommand(ws: WebSocket, cmd: any): Promise<void> {
    switch (cmd.action) {
      case "GET_INITIAL_STATE": {
        this.sendToClient(ws, {
          event: "INITIAL_STATE",
          data: {
            me: this.peerController.displayName,
            nodeId: this.peerController.getNodeId(),
            tcpPort: this.peerController.tcpPort,
            discoveryMode: this.peerController.discoveryMode,
            peers: this.peerController.getOnlinePeers(),
            channelStatus: "Plaintext (Chưa mã hóa - DHT Pure P2P)",
            logs: this.logger.getRecentLogs()
          }
        });
        break;
      }

      case "SEND_CHAT": {
        if (!cmd.receiver || !cmd.body) return;
        await this.peerController.sendChatMessage(cmd.receiver, cmd.body);
        break;
      }

      case "SEND_FILE": {
        if (!cmd.receiver || !cmd.filePath) return;
        await this.peerController.sendFile(cmd.receiver, cmd.filePath);
        break;
      }

      case "GET_CHAT_HISTORY": {
        if (!cmd.peer) return;
        const limit = cmd.limit || 50;
        const messages = this.peerController.getChatHistory(cmd.peer, limit, cmd.beforeTimestamp);
        this.sendToClient(ws, {
          event: "CHAT_HISTORY",
          data: {
            peer: cmd.peer,
            messages,
            hasMore: messages.length >= limit
          }
        });
        break;
      }

      case "DELETE_CHAT_HISTORY": {
        if (!cmd.peer) return;
        this.peerController.deleteChatHistory(cmd.peer);
        break;
      }

      default:
        this.logger.warn("SYSTEM", `Lệnh không xác định từ UI: ${cmd.action}`);
        break;
    }
  }

  public broadcast(payload: any): void {
    const raw = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  public sendToClient(ws: WebSocket, payload: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  public async close(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.close();
      } catch (e) {}
    }
    this.clients.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }
  }
}

