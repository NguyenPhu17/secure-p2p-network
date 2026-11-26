/**
 * P2P Network Manager & Dynamic Peer Orchestrator
 * Quản lý khởi tạo hệ thống, Gateway xác thực tập trung và tự động tạo Peer Node theo yêu cầu.
 */

import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, ChildProcess } from "node:child_process";
import { Pool } from "pg";
import client from "prom-client";
import { Logger } from "../common/logger.js";
import { initDatabase } from "../peer/db/migrations.js";
import { UserService } from "../peer/db/user-service.js";
import { JwtService } from "../peer/db/jwt-service.js";
import { RegistryService } from "../registry/registry-service.js";
import { FrameDecoder, encodeFrame } from "../common/framing.js";
import { BaseMessage, MessageType } from "../common/protocol.js";

const logger = new Logger("Manager", 500);
logger.enableFileLogging();

// Prometheus Metrics cho Manager & Service Discovery
const managerMetricsRegistry = new client.Registry();
client.collectDefaultMetrics({
  register: managerMetricsRegistry,
  prefix: "p2p_manager_"
});

const managedActiveNodesGauge = new client.Gauge({
  name: "p2p_managed_active_nodes",
  help: "Số lượng Peer Node đang được Manager điều phối",
  registers: [managerMetricsRegistry]
});

const authAttemptsCounter = new client.Counter({
  name: "p2p_auth_attempts_total",
  help: "Tổng số lượt đăng ký/đăng nhập qua Central Auth Gateway",
  labelNames: ["action", "status"],
  registers: [managerMetricsRegistry]
});

// Cấu hình Database từ biến môi trường
const dbHost = process.env.DB_HOST || "postgres";
const dbPort = parseInt(process.env.DB_PORT || "5432", 10);
const dbName = process.env.DB_NAME || "p2p_network";
const dbUser = process.env.DB_USER || "postgres";
const dbPassword = process.env.DB_PASSWORD;
if (!dbPassword) {
  throw new Error("Thiếu biến môi trường DB_PASSWORD. Vui lòng cấu hình trong .env hoặc môi trường.");
}

const pool = new Pool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPassword,
  max: 10,
  idleTimeoutMillis: 30000
});

const userService = new UserService(pool);

// Quản lý các tiến trình Peer Node đang chạy
interface NodeProcess {
  username: string;
  displayName: string;
  uiPort: number;
  tcpPort: number;
  child: ChildProcess;
  startedAt: number;
}

const activeNodes = new Map<string, NodeProcess>();

/**
 * Khởi động một Peer Node riêng biệt cho người dùng
 */
function spawnPeerNode(username: string, displayName: string, nodePort: number): NodeProcess | null {
  const cleanUsername = username.toLowerCase();
  const existing = activeNodes.get(cleanUsername);
  if (existing && existing.child && !existing.child.killed) {
    logger.info("SYSTEM", `Peer Node cho '${cleanUsername}' đang hoạt động tại UI:${existing.uiPort}, TCP:${existing.tcpPort}`);
    return existing;
  }

  const uiPort = nodePort;
  const tcpPort = nodePort + 5000;

  // Thu thập các node đang hoạt động để làm bootstrap DHT
  const bootstrapPeers: string[] = [];
  for (const [name, node] of activeNodes.entries()) {
    if (name !== cleanUsername) {
      bootstrapPeers.push(`127.0.0.1:${node.tcpPort}`);
    }
  }

  logger.info("SYSTEM", `🚀 Đang khởi động Peer Node mới cho '${cleanUsername}' (UI: ${uiPort}, TCP: ${tcpPort})...`);
  if (bootstrapPeers.length > 0) {
    logger.info("SYSTEM", `   Bootstrap DHT qua: ${bootstrapPeers.join(", ")}`);
  } else {
    logger.info("SYSTEM", `   Node đầu tiên trong mạng (Seed Node)`);
  }

  const currentFile = fileURLToPath(import.meta.url);
  const isCompiled = currentFile.endsWith(".js");
  const peerEntry = isCompiled
    ? path.resolve(path.dirname(currentFile), "../peer/index.js")
    : "peer/index.ts";

  const peerArgs = [
    "--name", cleanUsername,
    "--tcpPort", String(tcpPort),
    "--uiPort", String(uiPort),
    "--mode", "dht",
    "--ip", "127.0.0.1"
  ];
  if (bootstrapPeers.length > 0) {
    peerArgs.push("--bootstrap", bootstrapPeers.join(","));
  }

  const command = isCompiled ? process.execPath : "npx";
  const args = isCompiled ? [peerEntry, ...peerArgs] : ["tsx", peerEntry, ...peerArgs];

  const child = spawn(command, args, {
    env: {
      ...process.env,
      PEER_NAME: cleanUsername,
      PEER_TCP_PORT: String(tcpPort),
      PEER_UI_PORT: String(uiPort),
      PEER_ADVERTISE_IP: "127.0.0.1",
      DISCOVERY_MODE: "dht",
      BOOTSTRAP_PEERS: bootstrapPeers.join(",")
    },
    stdio: "inherit"
  });

  const nodeProcess: NodeProcess = {
    username: cleanUsername,
    displayName: displayName || cleanUsername,
    uiPort,
    tcpPort,
    child,
    startedAt: Date.now()
  };

  child.on("exit", (code, signal) => {
    logger.warn("SYSTEM", `Peer Node '${cleanUsername}' đã dừng (code: ${code}, signal: ${signal})`);
    activeNodes.delete(cleanUsername);
  });

  child.on("error", (err) => {
    logger.error("SYSTEM", `Lỗi tiến trình Peer Node '${cleanUsername}': ${err.message}`);
  });

  activeNodes.set(cleanUsername, nodeProcess);
  return nodeProcess;
}

/**
 * Tự động đồng bộ và phục hồi các Node cho người dùng đã đăng ký khi Manager khởi động
 */
async function autoRestoreExistingNodes(): Promise<void> {
  try {
    const users = await userService.listUsers();
    if (users.length === 0) {
      logger.info("SYSTEM", "Chưa có tài khoản nào trong hệ thống. Đang chờ người dùng đăng ký...");
      return;
    }

    logger.info("SYSTEM", `Tìm thấy ${users.length} tài khoản trong Database. Đang tự động khởi động các Node tương ứng...`);
    for (const u of users) {
      spawnPeerNode(u.username, u.displayName, u.nodePort);
      // Chờ 800ms giữa các node để Kademlia DHT bootstrap ổn định
      await new Promise((r) => setTimeout(r, 800));
    }
    logger.info("SYSTEM", `✅ Đã khôi phục thành công ${activeNodes.size} Peer Node!`);
  } catch (err: any) {
    logger.error("SYSTEM", `Lỗi phục hồi Peer Nodes: ${err.message}`);
  }
}

// ========================================================
// HTTP REST API Gateway (Port 3000)
// ========================================================
// Manager HTTP Gateway chạy ở port 4000 (tránh xung đột với Grafana ở port 3000)
const httpPort = parseInt(process.env.MANAGER_PORT || "4000", 10);

const httpServer = http.createServer(async (req, res) => {
  // Cấu hình CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // 1. Đăng ký tài khoản mới và Tự động tạo Node P2P
  if (req.method === "POST" && pathname === "/api/auth/register") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { username, password, displayName, nodePort } = JSON.parse(body || "{}");
        const authRes = await userService.register(username, password, displayName, nodePort);
        authAttemptsCounter.inc({ action: "register", status: authRes.success ? "success" : "failed" });
        if (authRes.success && authRes.user) {
          // Tự động khởi động Peer Node cho người dùng mới
          spawnPeerNode(authRes.user.username, authRes.user.displayName, authRes.user.nodePort);
          // Cho node 2500ms để khởi động, bind WebSocket port và kết nối DB
          await new Promise((r) => setTimeout(r, 2500));
        }
        res.writeHead(authRes.success ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(authRes));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 2. Đăng nhập tài khoản và Đảm bảo Node đang chạy
  if (req.method === "POST" && pathname === "/api/auth/login") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { username, password } = JSON.parse(body || "{}");
        const authRes = await userService.login(username, password);
        const loginStatus = authRes.success ? "success" : authRes.lockedMinutes ? "locked" : "failed";
        authAttemptsCounter.inc({ action: "login", status: loginStatus });
        if (authRes.success && authRes.user) {
          // Nếu Node chưa chạy (ví dụ vừa khởi động lại hệ thống), tự động bật lại
          spawnPeerNode(authRes.user.username, authRes.user.displayName, authRes.user.nodePort);
          await new Promise((r) => setTimeout(r, 2500));
        }
        res.writeHead(authRes.success ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(authRes));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 3. Xác thực JWT Token
  if (req.method === "GET" && pathname === "/api/auth/verify") {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ valid: false, error: "Thiếu Bearer Token" }));
      return;
    }
    const token = authHeader.substring(7);
    const result = userService.verifyToken(token);
    res.writeHead(result.valid ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // 4. Lấy danh sách người dùng
  if (req.method === "GET" && pathname === "/api/auth/users") {
    try {
      const users = await userService.listUsers();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, users }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 5. Prometheus Metrics của Manager
  if (req.method === "GET" && pathname === "/metrics") {
    try {
      managedActiveNodesGauge.set(activeNodes.size);
      const metricsText = await managerMetricsRegistry.metrics();
      res.writeHead(200, { "Content-Type": managerMetricsRegistry.contentType });
      res.end(metricsText);
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`# Metrics error: ${err.message}\n`);
    }
    return;
  }

  // 6. Prometheus HTTP Service Discovery (tự động cấp danh sách Peer Node đang chạy)
  if (req.method === "GET" && pathname === "/api/prometheus/targets") {
    const targetHost = process.env.PROMETHEUS_TARGET_HOST || "manager";
    const targets = Array.from(activeNodes.values()).map((n) => `${targetHost}:${n.uiPort}`);
    const payload = targets.length > 0 ? [{ targets, labels: { service: "peer-node" } }] : [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  // 7. Trạng thái hệ thống & Danh sách Node đang chạy
  if (req.method === "GET" && (pathname === "/api/status" || pathname === "/")) {
    const nodesList = Array.from(activeNodes.values()).map((n) => ({
      username: n.username,
      displayName: n.displayName,
      uiPort: n.uiPort,
      tcpPort: n.tcpPort,
      uptimeSec: Math.floor((Date.now() - n.startedAt) / 1000)
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "online",
      service: "P2P Orchestrator & Node Manager",
      activeNodesCount: activeNodes.size,
      nodes: nodesList
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Endpoint không tồn tại" }));
});

// ========================================================
// Registry Server trên TCP Port 7000 (Tùy chọn tương thích ngược)
// ========================================================
const registryPort = parseInt(process.env.REGISTRY_PORT || "7000", 10);
const registryService = new RegistryService(logger);

const registryServer = net.createServer((socket) => {
  const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
  const decoder = new FrameDecoder();
  let boundDisplayName: string | null = null;

  socket.on("data", (chunk: Buffer) => {
    decoder.push(
      chunk,
      (msg: BaseMessage) => {
        if (msg.type === MessageType.REGISTER) {
          const res = registryService.register(msg.sender, msg.payload, socket);
          socket.write(encodeFrame(res.ack));
          if (res.success) boundDisplayName = msg.sender;
        } else if (msg.type === MessageType.HEARTBEAT) {
          const ack = registryService.handleHeartbeat(msg.sender);
          if (ack) socket.write(encodeFrame(ack));
        }
      },
      (err: Error) => {
        logger.error("PROTOCOL", `Lỗi giải mã gói tin từ ${remoteAddress}: ${err.message}`);
      }
    );
  });

  socket.on("close", () => {
    if (boundDisplayName) {
      registryService.unregister(boundDisplayName, "TCP connection closed");
    }
  });

  socket.on("error", (err: Error) => {
    logger.warn("NETWORK", `Lỗi socket ${remoteAddress}: ${err.message}`);
  });
});

async function main() {
  logger.info("SYSTEM", "========================================================");
  logger.info("SYSTEM", "🚀 Khởi động P2P Network Manager & Dynamic Node Orchestrator");
  logger.info("SYSTEM", "========================================================");

  // 1. Khởi tạo Database Schema PostgreSQL
  try {
    await initDatabase(pool);
    logger.info("SYSTEM", "✅ Đã đồng bộ Schema Database PostgreSQL thành công.");
  } catch (err: any) {
    logger.error("SYSTEM", `Lỗi khởi tạo Database: ${err.message}`);
  }

  // 2. Khởi động HTTP Gateway (Port 3000)
  httpServer.listen(httpPort, "0.0.0.0", () => {
    logger.info("SYSTEM", `🚀 Central Auth Gateway & Node Manager đang lắng nghe tại HTTP port: ${httpPort}`);
  });

  // 3. Khởi động Registry Server (TCP Port 7000)
  registryServer.listen(registryPort, "0.0.0.0", () => {
    logger.info("SYSTEM", `🚀 Discovery Registry Server đang lắng nghe tại TCP port: ${registryPort}`);
    registryService.startHeartbeatMonitor();
  });

  // 4. Khôi phục các Node hiện có (nếu đã có người dùng đăng ký trước đó)
  await autoRestoreExistingNodes();

  // 5. Xử lý tắt hệ thống an toàn (Graceful shutdown)
  const shutdown = () => {
    logger.info("SYSTEM", "Nhận tín hiệu dừng. Đang tắt tất cả các Peer Node...");
    for (const [name, node] of activeNodes.entries()) {
      try {
        node.child.kill("SIGINT");
      } catch {}
    }
    registryService.closeAll();
    httpServer.close(() => {
      registryServer.close(() => {
        pool.end().then(() => {
          logger.info("SYSTEM", "P2P Manager đã dừng an toàn.");
          process.exit(0);
        });
      });
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("SYSTEM", `Lỗi nghiêm trọng tại Manager: ${err.message}`);
  process.exit(1);
});
