/**
 * Automated Verification Script for Milestone 4 (M4)
 * Kiểm thử: Cầu nối WebSocket giữa React UI và Peer Backend
 * (Commands, Events, Real-time status update, History retrieval).
 */

import net from "node:net";
import { WebSocket } from "ws";
import { RegistryService } from "../registry/registry-service.js";
import { PeerController } from "../peer/peer-controller.js";
import { UIBridge } from "../peer/ws/ui-bridge.js";
import { Logger } from "../common/logger.js";
import { FrameDecoder, encodeFrame } from "../common/framing.js";
import { BaseMessage, MessageType } from "../common/protocol.js";

const REGISTRY_PORT = 7003;
const ALICE_TCP = 8301;
const ALICE_UI = 3301;
const BOB_TCP = 8302;
const BOB_UI = 3302;

async function runM4Test() {
  console.log("=== BẮT ĐẦU KIỂM THỬ MỐC 4 (M4): UI WEBSOCKET BRIDGE ===");

  // 1. Khởi động Registry
  const regLogger = new Logger("TestRegistryM4");
  const registryService = new RegistryService(regLogger);
  const regServer = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    let boundName: string | null = null;
    socket.on("data", (chunk) => {
      decoder.push(chunk, (msg: BaseMessage) => {
        if (msg.type === MessageType.REGISTER) {
          const res = registryService.register(msg.sender, msg.payload, socket);
          socket.write(encodeFrame(res.ack));
          if (res.success) boundName = msg.sender;
        } else if (msg.type === MessageType.HEARTBEAT) {
          const ack = registryService.handleHeartbeat(msg.sender);
          if (ack) socket.write(encodeFrame(ack));
        }
      });
    });
    socket.on("close", () => {
      if (boundName) registryService.unregister(boundName);
    });
  });

  await new Promise<void>((resolve) => regServer.listen(REGISTRY_PORT, "127.0.0.1", () => resolve()));
  registryService.startHeartbeatMonitor();
  console.log("✅ Registry khởi động trên cổng", REGISTRY_PORT);

  // 2. Khởi động Alice và Bob
  const alice = new PeerController({
    displayName: "Alice",
    tcpPort: ALICE_TCP,
    registryPort: REGISTRY_PORT,
    dbPath: "data/test_Alice_m4.db"
  });
  const aliceBridge = new UIBridge(alice, ALICE_UI, alice.getLogger());
  await alice.start();
  await aliceBridge.start();

  const bob = new PeerController({
    displayName: "Bob",
    tcpPort: BOB_TCP,
    registryPort: REGISTRY_PORT,
    dbPath: "data/test_Bob_m4.db"
  });
  const bobBridge = new UIBridge(bob, BOB_UI, bob.getLogger());
  await bob.start();
  await bobBridge.start();

  // 3. Giả lập React UI kết nối tới Alice qua WebSocket
  console.log(`\nKết nối WebSocket UI tới ws://127.0.0.1:${ALICE_UI}...`);
  const ws = new WebSocket(`ws://127.0.0.1:${ALICE_UI}`);

  const receivedEvents: any[] = [];
  ws.on("message", (raw) => {
    const data = JSON.parse(raw.toString());
    receivedEvents.push(data);
  });

  await new Promise<void>((resolve) => {
    ws.on("open", () => resolve());
  });

  // Chờ sự kiện INITIAL_STATE
  await new Promise((r) => setTimeout(r, 600));

  const initState = receivedEvents.find((e) => e.event === "INITIAL_STATE");
  if (!initState || initState.data.me !== "Alice") {
    throw new Error(`[M4 FAILED] Không nhận được INITIAL_STATE hợp lệ: ${JSON.stringify(initState)}`);
  }
  console.log("✅ [M4 TEST 1] Nhận INITIAL_STATE thành công: me =", initState.data.me);

  // 4. Gửi lệnh SEND_CHAT từ UI
  console.log("\n[M4 TEST 2] UI gửi lệnh SEND_CHAT 'Chào Bob từ giao diện UI!'...");
  ws.send(
    JSON.stringify({
      action: "SEND_CHAT",
      receiver: "Bob",
      body: "Chào Bob từ giao diện UI!"
    })
  );

  // Chờ NEW_MESSAGE và MESSAGE_STATUS_UPDATE (delivered)
  await new Promise((r) => setTimeout(r, 800));

  const newMsgEvent = receivedEvents.find((e) => e.event === "NEW_MESSAGE");
  const deliveredEvent = receivedEvents.find(
    (e) => e.event === "MESSAGE_STATUS_UPDATE" && e.data.status === "delivered"
  );

  if (!newMsgEvent || newMsgEvent.data.body !== "Chào Bob từ giao diện UI!") {
    throw new Error("[M4 FAILED] UI không nhận được NEW_MESSAGE xác nhận!");
  }
  if (!deliveredEvent) {
    throw new Error("[M4 FAILED] UI không nhận được sự kiện cập nhật trạng thái 'delivered'!");
  }
  console.log("✅ [M4 TEST 2] UI gửi tin và nhận phản hồi delivered thời gian thực thành công!");

  // 5. Yêu cầu tải lịch sử từ UI
  console.log("\n[M4 TEST 3] UI gửi lệnh GET_CHAT_HISTORY...");
  ws.send(
    JSON.stringify({
      action: "GET_CHAT_HISTORY",
      peer: "Bob",
      limit: 50
    })
  );

  await new Promise((r) => setTimeout(r, 400));
  const histEvent = receivedEvents.find((e) => e.event === "CHAT_HISTORY");
  if (!histEvent || histEvent.data.messages.length === 0) {
    throw new Error("[M4 FAILED] Lấy lịch sử qua UI thất bại!");
  }
  console.log(`✅ [M4 TEST 3] Tải lịch sử qua UI thành công: ${histEvent.data.messages.length} tin.`);

  // Dọn dẹp
  ws.close();
  await aliceBridge.close();
  await bobBridge.close();
  await alice.close();
  await bob.close();
  registryService.closeAll();
  await new Promise<void>((resolve) => regServer.close(() => resolve()));

  console.log("\n🎉 TOÀN BỘ CÁC BÀI TEST MỐC 4 (M4) ĐÃ VƯỢT QUA HOÀN HẢO! 🎉");
  process.exit(0);
}

runM4Test().catch((err) => {
  console.error("❌ Test M4 thất bại:", err);
  process.exit(1);
});

