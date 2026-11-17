/**
 * UIBridge - WebSocket & HTTP Server làm cầu nối giữa Peer Backend và React UI
 * Lắng nghe kết nối WebSocket và HTTP REST API xác thực trên localhost.
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { PeerController } from "../peer-controller.js";
import { Logger, LogEntry } from "../../common/logger.js";
import { MetricsCollector } from "../metrics/metrics-collector.js";

export class UIBridge {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private metrics = MetricsCollector.getInstance();

  constructor(
    private peerController: PeerController,
    private uiPort: number,
    private logger: Logger
  ) {}

  public start(): Promise<void> {
    return new Promise((resolve) => {
      // 1. Tạo HTTP Server phục vụ REST Auth API (Login, Register, List Users)
      this.httpServer = http.createServer(async (req, res) => {
        const corsHeaders: Record<string, string> = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Content-Type": "application/json"
        };

        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }

        const url = req.url || "";

        // API Đăng nhập: POST /api/auth/login
        if (url === "/api/auth/login" && req.method === "POST") {
          try {
            const body = await this.readJsonBody(req);
            const result = await this.peerController.getUserService().login(body.username, body.password);
            res.writeHead(result.success ? 200 : 401, corsHeaders);
            res.end(JSON.stringify(result));
          } catch (e: any) {
            res.writeHead(500, corsHeaders);
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
          return;
        }

        // API Đăng ký: POST /api/auth/register
        if (url === "/api/auth/register" && req.method === "POST") {
          try {
            const body = await this.readJsonBody(req);
            const result = await this.peerController
              .getUserService()
              .register(body.username, body.password, body.displayName, body.nodePort || this.uiPort);
            res.writeHead(result.success ? 200 : 400, corsHeaders);
            res.end(JSON.stringify(result));
          } catch (e: any) {
            res.writeHead(500, corsHeaders);
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
          return;
        }

        // API Danh sách tài khoản: GET /api/auth/users
        if (url === "/api/auth/users" && req.method === "GET") {
          try {
            const users = await this.peerController.getUserService().listUsers();
            res.writeHead(200, corsHeaders);
            res.end(JSON.stringify({ success: true, users }));
          } catch (e: any) {
            res.writeHead(500, corsHeaders);
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
          return;
        }

        // API Xác thực Token: GET /api/auth/verify
        if (url.startsWith("/api/auth/verify") && req.method === "GET") {
          try {
            const authHeader = req.headers["authorization"] || "";
            let token = "";
            if (authHeader.startsWith("Bearer ")) {
              token = authHeader.slice(7).trim();
            } else {
              const parsedUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
              token = parsedUrl.searchParams.get("token") || "";
            }
            const result = this.peerController.getUserService().verifyToken(token);
            res.writeHead(result.valid ? 200 : 401, corsHeaders);
            res.end(JSON.stringify(result));
          } catch (e: any) {
            res.writeHead(500, corsHeaders);
            res.end(JSON.stringify({ valid: false, error: e.message }));
          }
          return;
        }

        // Endpoint xuất dữ liệu giám sát cho Prometheus: GET /metrics
        if (url === "/metrics" && req.method === "GET") {
          try {
            this.metrics.activePeersGauge.set(
              { node: this.peerController.displayName },
              this.peerController.getOnlinePeers().length
            );
            this.metrics.lamportClockGauge.set(
              { node: this.peerController.displayName },
              this.peerController.lamportClock.getClock()
            );

            const metricsText = await this.metrics.getMetricsText();
            res.writeHead(200, { "Content-Type": this.metrics.getContentType() });
            res.end(metricsText);
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`Lỗi Prometheus Metrics: ${e.message}`);
          }
          return;
        }

        // Endpoint mặc định kiểm tra tình trạng sức khỏe
        if (url === "/api/health") {
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ status: "ok", node: this.peerController.displayName, port: this.uiPort }));
          return;
        }

        res.writeHead(404, corsHeaders);
        res.end(JSON.stringify({ error: "Not Found" }));
      });

      // 2. Tích hợp WebSocket Server vào HTTP Server
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.httpServer.listen(this.uiPort, () => {
        this.logger.info("SYSTEM", `UIBridge Server (HTTP + WS) đang chạy tại port ${this.uiPort}`);
        resolve();
      });

      this.wss.on("connection", async (ws: WebSocket) => {
        this.clients.add(ws);
        this.logger.info("NETWORK", "React UI đã kết nối tới WebSocket Bridge.");

        // Gửi trạng thái ban đầu ngay khi UI vừa kết nối
        const knownPeers = await this.peerController.getKnownPeersForUI();
        this.sendToClient(ws, {
          event: "INITIAL_STATE",
          data: {
            me: this.peerController.displayName,
            nodeId: this.peerController.getNodeId(),
            tcpPort: this.peerController.tcpPort,
            discoveryMode: this.peerController.discoveryMode,
            peers: this.peerController.getOnlinePeers(),
            knownPeers,
            blockedPeers: this.peerController.getBlockedPeers(),
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

  private readJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(new Error("Dữ liệu JSON không hợp lệ"));
        }
      });
      req.on("error", reject);
    });
  }

  private async handleUICommand(ws: WebSocket, cmd: any): Promise<void> {
    switch (cmd.action) {
      case "GET_INITIAL_STATE": {
        const knownPeers = await this.peerController.getKnownPeersForUI();
        this.sendToClient(ws, {
          event: "INITIAL_STATE",
          data: {
            me: this.peerController.displayName,
            nodeId: this.peerController.getNodeId(),
            tcpPort: this.peerController.tcpPort,
            discoveryMode: this.peerController.discoveryMode,
            peers: this.peerController.getOnlinePeers(),
            knownPeers,
            blockedPeers: this.peerController.getBlockedPeers(),
            channelStatus: "Plaintext (Chưa mã hóa - DHT Pure P2P)",
            logs: this.logger.getRecentLogs()
          }
        });
        break;
      }

      case "AUTH_LOGIN": {
        const result = await this.peerController.getUserService().login(cmd.username, cmd.password);
        this.sendToClient(ws, { event: "AUTH_RESULT", data: result });
        break;
      }

      case "AUTH_REGISTER": {
        const result = await this.peerController
          .getUserService()
          .register(cmd.username, cmd.password, cmd.displayName, cmd.nodePort || this.uiPort);
        this.sendToClient(ws, { event: "AUTH_RESULT", data: result });
        break;
      }

      case "AUTH_USERS": {
        const users = await this.peerController.getUserService().listUsers();
        this.sendToClient(ws, { event: "AUTH_USERS_LIST", data: users });
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
        const before = cmd.beforeLamportClock !== undefined ? cmd.beforeLamportClock : cmd.beforeTimestamp;
        const messages = await this.peerController.getChatHistory(cmd.peer, limit, before);
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
        await this.peerController.deleteChatHistory(cmd.peer);
        break;
      }

      case "SIMULATE_BLOCK": {
        if (!cmd.peer) return;
        this.peerController.simulateFirewallBlock(cmd.peer, cmd.blocked !== false);
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

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }
}
