/**
 * Entrypoint của Registry Node (Discovery & Bootstrap Server)
 * Lắng nghe kết nối TCP từ các Peer Node (Chế độ Discovery tập trung tùy chọn / Legacy).
 */

import net from "node:net";
import { config } from "../common/config.js";
import { Logger } from "../common/logger.js";
import { RegistryService } from "./registry-service.js";
import { FrameDecoder, encodeFrame } from "../common/framing.js";
import { BaseMessage, MessageType } from "../common/protocol.js";

// Khởi tạo logger
const logger = new Logger("Registry", config.peer.maxLogEntries);
logger.enableFileLogging();

// Khởi tạo dịch vụ Registry
const registryService = new RegistryService(logger);

// Phân tích tham số dòng lệnh hoặc Biến môi trường
const args = process.argv.slice(2);
let port = process.env.REGISTRY_PORT ? parseInt(process.env.REGISTRY_PORT, 10) : config.registry.port;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
  }
}

const server = net.createServer((socket) => {
  const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
  logger.info("NETWORK", `Kết nối TCP mới từ ${remoteAddress}`);

  const decoder = new FrameDecoder();
  let boundDisplayName: string | null = null;

  socket.on("data", (chunk: Buffer) => {
    decoder.push(
      chunk,
      (msg: BaseMessage) => {
        handleIncomingMessage(msg, socket, (name) => {
          boundDisplayName = name;
        });
      },
      (err: Error) => {
        logger.error("PROTOCOL", `Lỗi giải mã gói tin từ ${remoteAddress}: ${err.message}`);
      }
    );
  });

  socket.on("close", () => {
    logger.info("NETWORK", `Đóng kết nối TCP từ ${remoteAddress} (Peer: ${boundDisplayName || "chưa đăng ký"})`);
    if (boundDisplayName) {
      registryService.unregister(boundDisplayName, "TCP connection closed");
    }
  });

  socket.on("error", (err: Error) => {
    logger.warn("NETWORK", `Lỗi socket ${remoteAddress} (${boundDisplayName || "anonymous"}): ${err.message}`);
  });
});

function handleIncomingMessage(
  msg: BaseMessage,
  socket: net.Socket,
  setBoundName: (name: string) => void
): void {
  logger.info(
    "PROTOCOL",
    `Nhận thông điệp [${msg.type}] từ '${msg.sender}'`,
    { type: msg.type, sender: msg.sender, seq: msg.seq },
    { direction: "IN", messageType: msg.type, peer: msg.sender }
  );

  switch (msg.type) {
    case MessageType.REGISTER: {
      const res = registryService.register(msg.sender, msg.payload, socket);
      socket.write(encodeFrame(res.ack));
      if (res.success) {
        setBoundName(msg.sender);
      }
      break;
    }

    case MessageType.HEARTBEAT: {
      const ack = registryService.handleHeartbeat(msg.sender);
      if (ack) {
        socket.write(encodeFrame(ack));
      }
      break;
    }

    default:
      logger.warn("PROTOCOL", `Loại message không hỗ trợ tại Registry: ${msg.type}`);
      break;
  }
}

// Bắt đầu lắng nghe
server.listen(port, "0.0.0.0", () => {
  logger.info("SYSTEM", `========================================================`);
  logger.info("SYSTEM", `🚀 REGISTRY (Discovery & Bootstrap Server) đang lắng nghe tại TCP port: ${port}`);
  logger.info("SYSTEM", `   Heartbeat Timeout: ${config.registry.heartbeatTimeoutMs}ms`);
  logger.info("SYSTEM", `========================================================`);
  registryService.startHeartbeatMonitor();
});

// Xử lý dừng server an toàn (Graceful shutdown)
process.on("SIGINT", () => {
  logger.info("SYSTEM", "Nhận tín hiệu SIGINT. Đang dừng Registry...");
  registryService.closeAll();
  server.close(() => {
    logger.info("SYSTEM", "Registry đã dừng an toàn.");
    process.exit(0);
  });
});

