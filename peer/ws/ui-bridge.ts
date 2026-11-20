/**
 * UIBridge - WebSocket & HTTP Server làm cầu nối giữa Peer Backend và React UI
 * Lắng nghe kết nối WebSocket và HTTP REST API xác thực trên localhost.
 * Tự động ánh xạ danh tính người dùng thực với node container P2P.
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
  private syncTimer: NodeJS.Timeout | null = null;

  // Bản đồ ánh xạ mặc định giữa UI Port và Tên Node Container P2P
  private portToNodeMap: Record<number, string> = {
    3001: "Alice",
    3002: "Bob",
    3003: "Charlie",
    3004: "David"
  };

  private nodeToPortMap: Record<string, number> = {
    "Alice": 3001,
    "Bob": 3002,
    "Charlie": 3003,
    "David": 3004
  };

  constructor(
    private peerController: PeerController,
    private uiPort: number,
    private logger: Logger
  ) {
    this.portToNodeMap[this.uiPort] = this.peerController.displayName;
    this.nodeToPortMap[this.peerController.displayName] = this.uiPort;
  }

  /**
   * Ánh xạ danh sách người dùng đã đăng ký thành danh sách Peer hiển thị trên UI.
   * Chỉ hiển thị các tài khoản người dùng thực tế, không hiển thị tên node ảo (Charlie, Bob...)
   */
  private async getMappedPeers(): Promise<{ me: string; peers: any[]; knownPeers: any[] }> {
    try {
      const users = await this.peerController.getUserService().listUsers();
      const onlineNodes = this.peerController.getOnlinePeers();
      const now = Date.now();

      // Xác định tên hiển thị của tài khoản gán cho node hiện tại
      const localUser = users.find((u) => u.nodePort === this.uiPort);
      const meName = localUser
        ? (localUser.displayName || localUser.username)
        : this.peerController.displayName;

      const peers: any[] = [];
      const knownPeers: any[] = [];

      for (const u of users) {
        // Bỏ qua chính bản thân mình trong danh sách chat
        if (localUser && u.username === localUser.username) continue;

        const peerUserName = u.displayName || u.username;
        const targetNodeName = this.portToNodeMap[u.nodePort];
        const onlineNode = targetNodeName
          ? onlineNodes.find(
              (n) => n.displayName.toLowerCase() === targetNodeName.toLowerCase()
            )
          : undefined;

        // Tiêu chuẩn Online thời gian thực:
        // Người dùng được tính là Online nếu có heartbeat trong vòng 10 giây gần nhất (now - lastSeenAt <= 10000)
        // và node P2P đang hoạt động.
        const isRecent = (now - (u.lastSeenAt || 0)) <= 10000;
        const isOnline = isRecent && (u.nodePort === this.uiPort || !!onlineNode);

        const peerInfo = {
          displayName: peerUserName,
          ip: onlineNode?.ip || (u.nodePort === this.uiPort ? "127.0.0.1" : "offline"),
          tcpPort: onlineNode?.tcpPort || (u.nodePort === this.uiPort ? this.peerController.tcpPort : 0),
          nodeId: onlineNode?.nodeId || "",
          online: isOnline,
          lastSeen: u.lastSeenAt || 0
        };

        knownPeers.push(peerInfo);
        if (isOnline) {
          peers.push(peerInfo);
        }
      }

      return { me: meName, peers, knownPeers };
    } catch (err: any) {
      this.logger.warn("SYSTEM", `Lỗi getMappedPeers: ${err.message}`);
      return {
        me: this.peerController.displayName,
        peers: this.peerController.getOnlinePeers(),
        knownPeers: await this.peerController.getKnownPeersForUI()
      };
    }
  }

  /**
   * Chuyển đổi tên người dùng (UI) thành tên node P2P container (Backend)
   */
  private async resolveNodeName(name: string): Promise<string> {
    if (!name) return name;
    try {
      const users = await this.peerController.getUserService().listUsers();
      const user = users.find(
        (u) =>
          u.username.toLowerCase() === name.toLowerCase() ||
          u.displayName.toLowerCase() === name.toLowerCase()
      );
      if (user && this.portToNodeMap[user.nodePort]) {
        return this.portToNodeMap[user.nodePort];
      }
    } catch {}
    return name;
  }

  /**
   * Chuyển đổi tên node P2P container trong tin nhắn thành tên người dùng thực tế
   */
  private async translateMessage(msg: any): Promise<any> {
    if (!msg) return msg;
    try {
      const users = await this.peerController.getUserService().listUsers();
      const copy = { ...msg };

      // Dịch sender nếu là node name (Alice, Bob, Charlie, David)
      const senderPort = this.nodeToPortMap[copy.sender];
      if (senderPort) {
        const senderUser = users.find((u) => u.nodePort === senderPort);
        if (senderUser) {
          copy.sender = senderUser.displayName || senderUser.username;
        }
      }

      // Dịch receiver nếu là node name
      const receiverPort = this.nodeToPortMap[copy.receiver];
      if (receiverPort) {
        const receiverUser = users.find((u) => u.nodePort === receiverPort);
        if (receiverUser) {
          copy.receiver = receiverUser.displayName || receiverUser.username;
        }
      }

      // Cập nhật conversation_id theo tên người dùng
      const partner = copy.direction === "out" ? copy.receiver : copy.sender;
      copy.conversation_id = `conv_${partner}`;

      return copy;
    } catch {
      return msg;
    }
  }

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

        const rawUrl = req.url || "";
        const cleanPath = rawUrl.split("?")[0].replace(/\/+$/, "") || "/";
        this.logger.info("NETWORK", `[HTTP API] ${req.method} ${cleanPath}`);

        // API Đăng nhập: POST /api/auth/login
        if (cleanPath === "/api/auth/login" && req.method === "POST") {
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
        if (cleanPath === "/api/auth/register" && req.method === "POST") {
          try {
            const body = await this.readJsonBody(req);
            const result = await this.peerController
              .getUserService()
              .register(body.username, body.password, body.displayName, body.nodePort);
            res.writeHead(result.success ? 200 : 400, corsHeaders);
            res.end(JSON.stringify(result));
            if (result.success) {
              const mapped = await this.getMappedPeers();
              this.broadcast({ event: "PEER_LIST_UPDATE", data: mapped.peers });
              this.broadcast({ event: "KNOWN_PEERS_UPDATE", data: mapped.knownPeers });
            }
          } catch (e: any) {
            res.writeHead(500, corsHeaders);
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
          return;
        }

        // API Danh sách tài khoản: GET /api/auth/users
        if (cleanPath === "/api/auth/users" && req.method === "GET") {
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
        if (cleanPath === "/api/auth/verify" && req.method === "GET") {
          try {
            const authHeader = req.headers["authorization"] || "";
            let token = "";
            if (authHeader.startsWith("Bearer ")) {
              token = authHeader.slice(7).trim();
            } else {
              const parsedUrl = new URL(rawUrl, `http://${req.headers.host || "localhost"}`);
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
        if (cleanPath === "/metrics" && req.method === "GET") {
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
        if (cleanPath === "/api/health") {
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ status: "ok", node: this.peerController.displayName, port: this.uiPort }));
          return;
        }

        res.writeHead(404, corsHeaders);
        res.end(JSON.stringify({ error: "Not Found", path: rawUrl }));
      });

      // 2. Tích hợp WebSocket Server vào HTTP Server
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.httpServer.listen(this.uiPort, "0.0.0.0", () => {
        this.logger.info("SYSTEM", `UIBridge Server (HTTP + WS) đang chạy tại port ${this.uiPort} (0.0.0.0)`);
        resolve();
      });

      this.wss.on("connection", async (ws: WebSocket) => {
        this.clients.add(ws);
        this.logger.info("NETWORK", "React UI đã kết nối tới WebSocket Bridge.");

        // Gửi trạng thái ban đầu đã ánh xạ theo tài khoản người dùng thực
        const mapped = await this.getMappedPeers();
        this.sendToClient(ws, {
          event: "INITIAL_STATE",
          data: {
            me: mapped.me,
            nodeId: this.peerController.getNodeId(),
            tcpPort: this.peerController.tcpPort,
            discoveryMode: this.peerController.discoveryMode,
            peers: mapped.peers,
            knownPeers: mapped.knownPeers,
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

        ws.on("close", async () => {
          this.clients.delete(ws);
          this.logger.info("NETWORK", "React UI đã ngắt kết nối WebSocket.");
          const uname = (ws as any).attachedUsername;
          if (uname) {
            await this.peerController.getUserService().setUserOffline(uname);
            const mapped = await this.getMappedPeers();
            this.broadcast({ event: "PEER_LIST_UPDATE", data: mapped.peers });
            this.broadcast({ event: "KNOWN_PEERS_UPDATE", data: mapped.knownPeers });
          }
        });

        ws.on("error", (err) => {
          this.logger.warn("NETWORK", `Lỗi kết nối UI WebSocket: ${err.message}`);
        });
      });

      // Lắng nghe sự kiện từ PeerController để phát lên UI
      this.peerController.onUIEvent(async (event, data) => {
        if (event === "PEER_LIST_UPDATE" || event === "KNOWN_PEERS_UPDATE") {
          const mapped = await this.getMappedPeers();
          this.broadcast({ event: "PEER_LIST_UPDATE", data: mapped.peers });
          this.broadcast({ event: "KNOWN_PEERS_UPDATE", data: mapped.knownPeers });
          return;
        }

        if (event === "NEW_MESSAGE") {
          const translated = await this.translateMessage(data);
          this.broadcast({ event: "NEW_MESSAGE", data: translated });
          return;
        }

        if (event === "FIREWALL_STATUS_UPDATE") {
          const users = await this.peerController.getUserService().listUsers();
          const port = this.nodeToPortMap[data.peer];
          const u = port ? users.find((x) => x.nodePort === port) : null;
          const peerName = u ? (u.displayName || u.username) : data.peer;
          this.broadcast({ event: "FIREWALL_STATUS_UPDATE", data: { ...data, peer: peerName } });
          return;
        }

        this.broadcast({ event, data });
      });

      // Định kỳ đồng bộ danh sách peer người dùng mỗi 2.5 giây cho tất cả client
      this.syncTimer = setInterval(async () => {
        if (this.clients.size > 0) {
          try {
            const mapped = await this.getMappedPeers();
            this.broadcast({ event: "PEER_LIST_UPDATE", data: mapped.peers });
            this.broadcast({ event: "KNOWN_PEERS_UPDATE", data: mapped.knownPeers });
          } catch {}
        }
      }, 2500);

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
      case "USER_HEARTBEAT": {
        if (cmd.username) {
          (ws as any).attachedUsername = cmd.username;
          await this.peerController.getUserService().touchUserPresence(cmd.username);
        }
        break;
      }

      case "USER_LOGOUT": {
        if (cmd.username) {
          await this.peerController.getUserService().setUserOffline(cmd.username);
          const mapped = await this.getMappedPeers();
          this.broadcast({ event: "PEER_LIST_UPDATE", data: mapped.peers });
          this.broadcast({ event: "KNOWN_PEERS_UPDATE", data: mapped.knownPeers });
        }
        break;
      }

      case "GET_INITIAL_STATE": {
        const mapped = await this.getMappedPeers();
        this.sendToClient(ws, {
          event: "INITIAL_STATE",
          data: {
            me: mapped.me,
            nodeId: this.peerController.getNodeId(),
            tcpPort: this.peerController.tcpPort,
            discoveryMode: this.peerController.discoveryMode,
            peers: mapped.peers,
            knownPeers: mapped.knownPeers,
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
          .register(cmd.username, cmd.password, cmd.displayName, cmd.nodePort);
        this.sendToClient(ws, { event: "AUTH_RESULT", data: result });
        if (result.success) {
          const mapped = await this.getMappedPeers();
          this.broadcast({ event: "PEER_LIST_UPDATE", data: mapped.peers });
          this.broadcast({ event: "KNOWN_PEERS_UPDATE", data: mapped.knownPeers });
        }
        break;
      }

      case "AUTH_USERS": {
        const users = await this.peerController.getUserService().listUsers();
        this.sendToClient(ws, { event: "AUTH_USERS_LIST", data: users });
        break;
      }

      case "SEND_CHAT": {
        if (!cmd.receiver || !cmd.body) return;
        const targetNode = await this.resolveNodeName(cmd.receiver);
        await this.peerController.sendChatMessage(targetNode, cmd.body);
        break;
      }

      case "SEND_FILE": {
        if (!cmd.receiver || !cmd.filePath) return;
        const targetNode = await this.resolveNodeName(cmd.receiver);
        await this.peerController.sendFile(targetNode, cmd.filePath);
        break;
      }

      case "GET_CHAT_HISTORY": {
        if (!cmd.peer) return;
        const targetNode = await this.resolveNodeName(cmd.peer);
        const limit = cmd.limit || 50;
        const before = cmd.beforeLamportClock !== undefined ? cmd.beforeLamportClock : cmd.beforeTimestamp;
        const rawMessages = await this.peerController.getChatHistory(targetNode, limit, before);
        const translatedMessages = await Promise.all(
          rawMessages.map((m) => this.translateMessage(m))
        );
        this.sendToClient(ws, {
          event: "CHAT_HISTORY",
          data: {
            peer: cmd.peer,
            messages: translatedMessages,
            hasMore: rawMessages.length >= limit
          }
        });
        break;
      }

      case "DELETE_CHAT_HISTORY": {
        if (!cmd.peer) return;
        const targetNode = await this.resolveNodeName(cmd.peer);
        await this.peerController.deleteChatHistory(targetNode);
        this.sendToClient(ws, {
          event: "CHAT_HISTORY_CLEARED",
          data: { peer: cmd.peer }
        });
        break;
      }

      case "SIMULATE_BLOCK": {
        if (!cmd.peer) return;
        const targetNode = await this.resolveNodeName(cmd.peer);
        this.peerController.simulateFirewallBlock(targetNode, cmd.blocked !== false);
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
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

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
