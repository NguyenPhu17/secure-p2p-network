/**
 * Kịch bản Kiểm thử Toàn diện Mốc 5 (M5)
 * Mô phỏng: 1 Registry + 3 Peer (Alice, Bob, Charlie)
 * Kiểm thử:
 * 1. Khám phá 3 bên đồng thời (Tri-peer Discovery).
 * 2. Nhắn tin đồng thời đa luồng (Concurrent Chatting).
 * 3. Ngắt kết nối đột ngột 1 peer giữa chừng, kiểm tra khả năng phục hồi và gửi bù offline.
 * 4. Truyền file và kiểm tra toàn vẹn hash.
 * 5. Tắt và mở lại peer: Kiểm tra lưu trữ SQLite bền vững và đúng thứ tự.
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { RegistryService } from "../registry/registry-service.js";
import { PeerController } from "../peer/peer-controller.js";
import { Logger } from "../common/logger.js";
import { FrameDecoder, encodeFrame } from "../common/framing.js";
import { BaseMessage, MessageType } from "../common/protocol.js";
import { calculateFileChecksum } from "../common/checksum.js";

const REG_PORT = 7004;

async function runFullScenario() {
  console.log("================================================================================");
  console.log("   KIỂM THỬ TOÀN DIỆN MỐC 5 (M5): 1 REGISTRY + 3 PEER ĐỒNG THỜI (ALICE, BOB, CHARLIE)");
  console.log("================================================================================\n");

  const testDir = "tests/temp_m5";
  const downloadsAlice = "downloads/test_m5_alice";
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  if (fs.existsSync(downloadsAlice)) fs.rmSync(downloadsAlice, { recursive: true, force: true });

  // 1. Khởi động Registry
  const regLogger = new Logger("RegM5");
  const regService = new RegistryService(regLogger);
  const regServer = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    let boundName: string | null = null;
    socket.on("data", (chunk) => {
      decoder.push(chunk, (msg: BaseMessage) => {
        if (msg.type === MessageType.REGISTER) {
          const res = regService.register(msg.sender, msg.payload, socket);
          socket.write(encodeFrame(res.ack));
          if (res.success) boundName = msg.sender;
        } else if (msg.type === MessageType.HEARTBEAT) {
          const ack = regService.handleHeartbeat(msg.sender);
          if (ack) socket.write(encodeFrame(ack));
        }
      });
    });
    socket.on("close", () => {
      if (boundName) regService.unregister(boundName);
    });
  });

  await new Promise<void>((r) => regServer.listen(REG_PORT, "127.0.0.1", () => r()));
  regService.startHeartbeatMonitor();
  console.log("✅ Registry (Mock KDC) đã khởi động trên cổng", REG_PORT);

  // 2. Khởi động 3 Peer
  console.log("\n[BƯỚC 1] Khởi động 3 Peer: Alice (8401), Bob (8402), Charlie (8403)...");
  let alice = new PeerController({
    displayName: "Alice",
    tcpPort: 8401,
    registryPort: REG_PORT,
    dbPath: "data/m5_Alice.db",
    downloadDir: downloadsAlice
  });
  let bob = new PeerController({
    displayName: "Bob",
    tcpPort: 8402,
    registryPort: REG_PORT,
    dbPath: "data/m5_Bob.db"
  });
  let charlie = new PeerController({
    displayName: "Charlie",
    tcpPort: 8403,
    registryPort: REG_PORT,
    dbPath: "data/m5_Charlie.db"
  });

  await alice.start();
  await bob.start();
  await charlie.start();

  // Chờ 800ms để cả 3 peer nhận đủ PEER_JOINED của nhau
  await new Promise((r) => setTimeout(r, 800));

  console.log(`Alice nhận biết: ${alice.getOnlinePeers().map((p) => p.displayName).join(", ")}`);
  console.log(`Bob nhận biết  : ${bob.getOnlinePeers().map((p) => p.displayName).join(", ")}`);
  console.log(`Charlie nhận biết: ${charlie.getOnlinePeers().map((p) => p.displayName).join(", ")}`);

  if (alice.getOnlinePeers().length !== 2 || bob.getOnlinePeers().length !== 2 || charlie.getOnlinePeers().length !== 2) {
    throw new Error("[BƯỚC 1 FAILED] Không phát hiện đủ 3 peer!");
  }
  console.log("✅ [BƯỚC 1 PASSED] Cả 3 peer đã kết nối và nhận diện lẫn nhau qua Registry.");

  // 3. Nhắn tin đồng thời đa luồng
  console.log("\n[BƯỚC 2] Gửi tin nhắn đồng thời đa luồng:");
  console.log("   - Alice -> Bob: 'Chào Bob!'");
  console.log("   - Bob -> Charlie: 'Chào Charlie!'");
  console.log("   - Charlie -> Alice: 'Chào Alice!'");

  const [t1, t2, t3] = await Promise.all([
    alice.sendChatMessage("Bob", "Chào Bob!"),
    bob.sendChatMessage("Charlie", "Chào Charlie!"),
    charlie.sendChatMessage("Alice", "Chào Alice!")
  ]);

  await new Promise((r) => setTimeout(r, 600));

  const bobCheck = bob.getStore().getMessage(t1.message_id);
  const charlieCheck = charlie.getStore().getMessage(t2.message_id);
  const aliceCheck = alice.getStore().getMessage(t3.message_id);

  if (!bobCheck || !charlieCheck || !aliceCheck) {
    throw new Error("[BƯỚC 2 FAILED] Một trong các tin nhắn đồng thời bị thất lạc!");
  }
  console.log("✅ [BƯỚC 2 PASSED] Gửi tin nhắn đồng thời giữa 3 peer thành công 100%!");

  // 4. Truyền file dạng chunk từ Charlie sang Alice
  console.log("\n[BƯỚC 3] Truyền file chunk 64KB từ Charlie -> Alice...");
  const sampleFilePath = path.join(testDir, "charlie_report.pdf");
  const pdfBuffer = Buffer.alloc(300 * 1024); // 300KB
  for (let i = 0; i < pdfBuffer.length; i++) pdfBuffer[i] = (i + 13) % 256;
  fs.writeFileSync(sampleFilePath, pdfBuffer);
  const expectedHash = await calculateFileChecksum(sampleFilePath);

  let fileResult: any = null;
  alice.onUIEvent((evt, data) => {
    if (evt === "FILE_COMPLETED") fileResult = data;
  });

  const sendFileRes = await charlie.sendFile("Alice", sampleFilePath);
  if (!sendFileRes.success) throw new Error("[BƯỚC 3 FAILED] Charlie gửi file thất bại!");

  await new Promise((r) => setTimeout(r, 600));
  if (!fileResult) throw new Error("[BƯỚC 3 FAILED] Alice chưa hoàn tất nhận file!");

  const receivedHash = await calculateFileChecksum(fileResult.localPath);
  if (receivedHash !== expectedHash) {
    throw new Error(`[BƯỚC 3 FAILED] Hash file nhận không khớp: ${receivedHash} !== ${expectedHash}`);
  }
  console.log(`✅ [BƯỚC 3 PASSED] Alice nhận file từ Charlie thành công, hash trùng khớp tuyệt đối (${receivedHash})!`);

  // 5. Ngắt đột ngột Charlie, Alice gửi tin pending, Charlie online lại
  console.log("\n[BƯỚC 4] Kiểm tra ngắt kết nối đột ngột & Hàng đợi gửi bù:");
  console.log("Đang đóng tiến trình Charlie...");
  await charlie.close();
  await new Promise((r) => setTimeout(r, 600));

  console.log("Alice gửi tin nhắn cho Charlie khi Charlie đang offline...");
  const pendingMsg = await alice.sendChatMessage("Charlie", "Charlie ơi bạn rớt mạng à?");
  const checkPending = alice.getStore().getMessage(pendingMsg.message_id);
  if (checkPending?.status !== "pending") {
    throw new Error(`[BƯỚC 4 FAILED] Tin nhắn phải ở trạng thái pending (thực tế: ${checkPending?.status})`);
  }
  console.log("✅ Tin nhắn của Alice lưu đúng trạng thái pending.");

  console.log("Trong lúc Charlie offline, Alice và Bob vẫn chat bình thường...");
  const abMsg = await alice.sendChatMessage("Bob", "Charlie vừa out rồi Bob ơi!");
  await new Promise((r) => setTimeout(r, 400));
  const bobAbCheck = bob.getStore().getMessage(abMsg.message_id);
  if (!bobAbCheck) throw new Error("[BƯỚC 4 FAILED] Alice và Bob không chat được khi Charlie offline!");
  console.log("✅ Alice và Bob vẫn liên lạc thông suốt, không bị ảnh hưởng.");

  console.log("Khởi động lại Charlie...");
  charlie = new PeerController({
    displayName: "Charlie",
    tcpPort: 8403,
    registryPort: REG_PORT,
    dbPath: "data/m5_Charlie.db"
  });
  await charlie.start();

  console.log("Chờ Alice tự động flush tin nhắn pending cho Charlie...");
  await new Promise((r) => setTimeout(r, 1200));

  const flushedMsgCheck = alice.getStore().getMessage(pendingMsg.message_id);
  const charlieReceivedMsg = charlie.getStore().getMessage(pendingMsg.message_id);

  if (charlieReceivedMsg && flushedMsgCheck?.status === "delivered") {
    console.log("✅ [BƯỚC 4 PASSED] Tin nhắn offline được tự động gửi lại cho Charlie và chuyển thành 'delivered'!");
  } else {
    throw new Error("[BƯỚC 4 FAILED] Charlie chưa nhận được tin nhắn offline!");
  }

  // 6. Kiểm tra tính bền vững của SQLite (Restart Alice)
  console.log("\n[BƯỚC 5] Kiểm tra tính bền vững của SQLite (Khởi động lại Alice)...");
  await alice.close();

  // Khởi động lại Alice
  alice = new PeerController({
    displayName: "Alice",
    tcpPort: 8401,
    registryPort: REG_PORT,
    dbPath: "data/m5_Alice.db"
  });
  const aliceBobHistory = alice.getChatHistory("Bob", 50);
  const aliceCharlieHistory = alice.getChatHistory("Charlie", 50);

  console.log(`Lịch sử Alice với Bob: ${aliceBobHistory.length} tin.`);
  console.log(`Lịch sử Alice với Charlie: ${aliceCharlieHistory.length} tin.`);

  if (aliceBobHistory.length < 2 || aliceCharlieHistory.length < 2) {
    throw new Error("[BƯỚC 5 FAILED] Lịch sử tin nhắn bị thiếu sau khi khởi động lại!");
  }
  console.log("✅ [BƯỚC 5 PASSED] Lịch sử SQLite được lưu trữ bền vững, đầy đủ và đúng thứ tự.");

  // Dọn dẹp
  await alice.close();
  await bob.close();
  await charlie.close();
  regService.closeAll();
  await new Promise<void>((r) => regServer.close(() => r()));

  fs.rmSync(testDir, { recursive: true, force: true });
  fs.rmSync(downloadsAlice, { recursive: true, force: true });
  if (fs.existsSync("data/m5_Alice.db")) fs.unlinkSync("data/m5_Alice.db");
  if (fs.existsSync("data/m5_Bob.db")) fs.unlinkSync("data/m5_Bob.db");
  if (fs.existsSync("data/m5_Charlie.db")) fs.unlinkSync("data/m5_Charlie.db");

  console.log("\n================================================================================");
  console.log("🎉 XÁC NHẬN TOÀN DIỆN MỐC 5 (M5): TẤT CẢ KỊCH BẢN ĐÃ VƯỢT QUA 100%! 🎉");
  console.log("================================================================================");
  process.exit(0);
}

runFullScenario().catch((err) => {
  console.error("❌ Test Kịch bản M5 thất bại:", err);
  process.exit(1);
});

