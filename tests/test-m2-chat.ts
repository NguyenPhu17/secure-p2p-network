/**
 * Automated Verification Script for Milestone 2 (M2)
 * Kiểm thử: Chat 1-1 qua TCP, ACK delivery, Deduplication chống trùng tin,
 * Hàng đợi tin offline (pending -> delivered), và Lịch sử SQLite riêng cho từng Peer.
 */

import net from "node:net";
import fs from "node:fs";
import { RegistryService } from "../registry/registry-service.js";
import { PeerController } from "../peer/peer-controller.js";
import { Logger } from "../common/logger.js";
import { FrameDecoder, encodeFrame } from "../common/framing.js";
import { BaseMessage, MessageType } from "../common/protocol.js";

const REGISTRY_PORT = 7001; // Dùng port riêng để tránh xung đột

async function runM2Test() {
  console.log("=== BẮT ĐẦU KIỂM THỬ MỐC 2 (M2): CHAT 1-1, ACK, DEDUPLICATION & OFFLINE QUEUE ===");

  // Dọn dẹp DB test cũ nếu có
  if (fs.existsSync("data/test_Alice.db")) fs.unlinkSync("data/test_Alice.db");
  if (fs.existsSync("data/test_Bob.db")) fs.unlinkSync("data/test_Bob.db");

  // 1. Khởi tạo Registry Server
  const regLogger = new Logger("TestRegistry");
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

  await new Promise<void>((resolve) => {
    regServer.listen(REGISTRY_PORT, "127.0.0.1", () => resolve());
  });
  registryService.startHeartbeatMonitor();
  console.log("✅ Registry khởi động thành công trên cổng", REGISTRY_PORT);

  // 2. Khởi tạo Alice và Bob
  const alice = new PeerController({
    displayName: "Alice",
    tcpPort: 8101,
    registryPort: REGISTRY_PORT,
    dbPath: "data/test_Alice.db"
  });

  let bob = new PeerController({
    displayName: "Bob",
    tcpPort: 8102,
    registryPort: REGISTRY_PORT,
    dbPath: "data/test_Bob.db"
  });

  await alice.start();
  await bob.start();

  // Chờ 500ms để 2 peer nhận diện lẫn nhau qua PEER_JOINED
  await new Promise((r) => setTimeout(r, 600));

  // TEST 1: Alice gửi tin cho Bob
  console.log("\n[TEST 1] Alice gửi tin nhắn 'Xin chào Bob!' cho Bob...");
  const msg1 = await alice.sendChatMessage("Bob", "Xin chào Bob!");

  // Chờ Bob xử lý và gửi CHAT_ACK về cho Alice
  await new Promise((r) => setTimeout(r, 500));

  const aliceStoredMsg = alice.getStore().getMessage(msg1.message_id);
  const bobStoredMsg = bob.getStore().getMessage(msg1.message_id);

  if (!bobStoredMsg || bobStoredMsg.body !== "Xin chào Bob!") {
    throw new Error("[TEST 1 FAILED] Bob không nhận được hoặc không lưu đúng tin nhắn!");
  }
  if (aliceStoredMsg?.status !== "delivered") {
    throw new Error(`[TEST 1 FAILED] Alice chưa nhận được ACK (status = ${aliceStoredMsg?.status})`);
  }
  console.log("✅ [TEST 1 PASSED] Alice gửi tin thành công -> Bob nhận được -> Alice nhận ACK 'delivered'!");

  // TEST 2: Kiểm tra Deduplication (Gửi lại cùng một message_id)
  console.log("\n[TEST 2] Kiểm tra Deduplication: Gửi trùng lặp message_id...");
  const initialBobHistory = bob.getChatHistory("Alice");
  const initialCount = initialBobHistory.length;

  // Giả lập gửi lại tin cũ
  const duplicateMsg: BaseMessage = {
    type: MessageType.CHAT,
    message_id: msg1.message_id, // Trùng ID
    sender: "Alice",
    receiver: "Bob",
    seq: msg1.seq,
    timestamp: msg1.timestamp,
    payload: { body: "Xin chào Bob!" },
    nonce: null,
    mac_or_signature: null
  };

  // Alice gửi trực tiếp gói tin trùng qua TCP tới Bob
  const bobInfo = alice.getOnlinePeers().find((p) => p.displayName === "Bob");
  const tempSocket = new net.Socket();
  await new Promise<void>((resolve) => {
    tempSocket.connect(bobInfo!.tcpPort, bobInfo!.ip, () => {
      tempSocket.write(encodeFrame(duplicateMsg), () => resolve());
    });
  });
  await new Promise((r) => setTimeout(r, 500));
  tempSocket.destroy();

  const newBobHistory = bob.getChatHistory("Alice");
  if (newBobHistory.length === initialCount) {
    console.log(`✅ [TEST 2 PASSED] Bob phát hiện trùng lặp và không ghi thêm (vẫn có ${initialCount} tin)!`);
  } else {
    throw new Error(`[TEST 2 FAILED] Tin nhắn bị ghi trùng trong DB: ${newBobHistory.length} > ${initialCount}`);
  }

  // TEST 3: Offline Message Queue (Bob rớt mạng -> Alice gửi tin -> Bob online lại -> tự gửi tiếp)
  console.log("\n[TEST 3] Kiểm tra Hàng đợi tin offline...");
  console.log("Đang đóng Bob để giả lập Bob rớt mạng...");
  await bob.close();
  await new Promise((r) => setTimeout(r, 500));

  console.log("Alice gửi tin 'Bob ơi, bạn có đó không?' khi Bob đang offline...");
  const offlineMsg = await alice.sendChatMessage("Bob", "Bob ơi, bạn có đó không?");
  const aliceOfflineCheck = alice.getStore().getMessage(offlineMsg.message_id);

  if (aliceOfflineCheck?.status !== "pending") {
    throw new Error(`[TEST 3 FAILED] Tin nhắn khi đối phương offline phải có trạng thái 'pending' (thực tế: ${aliceOfflineCheck?.status})`);
  }
  console.log("✅ Alice đã lưu tin vào hàng đợi với trạng thái 'pending'!");

  console.log("Khởi động lại Bob...");
  bob = new PeerController({
    displayName: "Bob",
    tcpPort: 8102,
    registryPort: REGISTRY_PORT,
    dbPath: "data/test_Bob.db"
  });
  await bob.start();

  // Chờ Registry broadcast PEER_JOINED và Alice tự động flush pending message
  console.log("Chờ Alice tự động flush hàng đợi pending tin nhắn cho Bob...");
  await new Promise((r) => setTimeout(r, 1200));

  const aliceFlushedMsg = alice.getStore().getMessage(offlineMsg.message_id);
  const bobReceivedOfflineMsg = bob.getStore().getMessage(offlineMsg.message_id);

  if (bobReceivedOfflineMsg && aliceFlushedMsg?.status === "delivered") {
    console.log("✅ [TEST 3 PASSED] Hàng đợi offline hoạt động xuất sắc: Tin nhắn tự gửi lại và chuyển sang 'delivered'!");
  } else {
    throw new Error(
      `[TEST 3 FAILED] Tin offline chưa tới được Bob hoặc status chưa thành delivered (Alice status: ${aliceFlushedMsg?.status})`
    );
  }

  // TEST 4: Phân trang & Xóa lịch sử
  console.log("\n[TEST 4] Kiểm tra tải lịch sử phân trang và xóa lịch sử cuộc hội thoại...");
  const aliceHistory = alice.getChatHistory("Bob", 50);
  console.log(`Lịch sử cuộc hội thoại của Alice với Bob: ${aliceHistory.length} tin.`);
  if (aliceHistory.length !== 2) {
    throw new Error(`[TEST 4 FAILED] Số lượng tin không đúng: mong muốn 2, thực tế ${aliceHistory.length}`);
  }

  alice.deleteChatHistory("Bob");
  const emptyHistory = alice.getChatHistory("Bob", 50);
  if (emptyHistory.length === 0) {
    console.log("✅ [TEST 4 PASSED] Xóa lịch sử cuộc hội thoại thành công!");
  } else {
    throw new Error("[TEST 4 FAILED] Lịch sử vẫn còn sau khi xóa!");
  }

  // Dọn dẹp
  await alice.close();
  await bob.close();
  registryService.closeAll();
  await new Promise<void>((resolve) => regServer.close(() => resolve()));

  // Xóa DB test
  if (fs.existsSync("data/test_Alice.db")) fs.unlinkSync("data/test_Alice.db");
  if (fs.existsSync("data/test_Bob.db")) fs.unlinkSync("data/test_Bob.db");

  console.log("\n🎉 TOÀN BỘ CÁC BÀI TEST MỐC 2 (M2) ĐÃ VƯỢT QUA HOÀN HẢO! 🎉");
  process.exit(0);
}

runM2Test().catch((err) => {
  console.error("❌ Test M2 thất bại:", err);
  process.exit(1);
});

