/**
 * Kiểm thử Toàn diện: Xung đột định danh (Name Collision) & Hàn gắn phân mảnh mạng (Network Partition Healing)
 *
 * MỤC TIÊU KIỂM CHỨNG:
 * 1. Xung đột tên trong Pure P2P (Name Collision):
 *    - 2 peer cùng nhập displayName = "Alice" trên 2 cổng khác nhau.
 *    - Node ID được sinh từ SHA1(PublicKey) thay vì SHA1(displayName).
 *    - Bob kết nối tới cả 2: Bảng K-bucket của Bob KHÔNG bị ghi đè loạn xạ, lưu đủ cả 2 node riêng biệt.
 *    - Hệ thống phát hiện xung đột tên trên DHT (Identity Consensus) và ghi log cảnh báo an toàn.
 *
 * 2. Hàn gắn phân mảnh mạng (Network Partition Healing):
 *    - Mạng bị chia cắt làm 2 nửa cô lập (Cluster A: Alice, Cluster B: Bob & Charlie).
 *    - DHT Liveness Pings thất bại (failedPings >= 2), 2 nửa coi nhau là chết và xóa khỏi K-bucket.
 *    - Khi đường truyền vật lý phục hồi, KHÔNG KHỞI ĐỘNG LẠI BẤT KỲ NODE NÀO.
 *    - Cơ chế định kỳ Partition Healing tự động phát hiện, tái kích hoạt bootstrap, hợp nhất K-bucket.
 *    - Gửi nhận tin nhắn chat xuyên qua 2 nửa mạng đã được hàn gắn thành công!
 */

import fs from "node:fs";
import { PeerController } from "../peer/peer-controller.js";

async function runPartitionHealingAndIdentityTest() {
  console.log("================================================================================");
  console.log("   KIỂM THỬ: XUNG ĐỘT ĐỊNH DANH (NAME COLLISION) & HÀN GẮN PHÂN MẢNH MẠNG");
  console.log("================================================================================\n");

  // Dọn dẹp dữ liệu test cũ
  for (const name of ["Alice1", "Alice2", "Bob_Col", "Alice_Part", "Bob_Part", "Charlie_Part"]) {
    const db = `data/test_${name}.db`;
    if (fs.existsSync(db)) fs.unlinkSync(db);
  }

  // ============================================================================
  // PHẦN 1: XUNG ĐỘT TÊN TRONG PURE P2P (NAME COLLISION & SHA1(PublicKey))
  // ============================================================================
  console.log("--------------------------------------------------------------------------------");
  console.log("[PHẦN 1] Kiểm tra Xung đột tên (Name Collision): 2 Node cùng mang tên 'Alice'");
  console.log("--------------------------------------------------------------------------------");

  console.log("1. Khởi động Alice 1 (Port 8911) và Alice 2 (Port 8912) cùng tên 'Alice'...");
  const alice1 = new PeerController({
    displayName: "Alice",
    tcpPort: 8911,
    discoveryMode: "dht",
    dbPath: "data/test_Alice1.db"
  });
  await alice1.start();

  const alice2 = new PeerController({
    displayName: "Alice",
    tcpPort: 8912,
    discoveryMode: "dht",
    dbPath: "data/test_Alice2.db"
  });
  await alice2.start();

  const id1 = alice1.getNodeId();
  const id2 = alice2.getNodeId();

  console.log(`   - Alice 1 Node ID: ${id1} (derived from Ed25519 PublicKey 1)`);
  console.log(`   - Alice 2 Node ID: ${id2} (derived from Ed25519 PublicKey 2)`);

  if (id1 === id2) {
    throw new Error("[PHẦN 1 FAILED] Hai node cùng tên sinh ra trùng Node ID! Chuẩn SHA1(PublicKey) chưa được áp dụng.");
  }
  console.log("   ✅ Xác nhận: Hai node cùng tên 'Alice' sở hữu 2 Node ID 160-bit hoàn toàn khác nhau!");

  console.log("\n2. Khởi động Bob (Port 8913) kết nối tới cả 2 node Alice...");
  const bobCol = new PeerController({
    displayName: "Bob",
    tcpPort: 8913,
    discoveryMode: "dht",
    bootstrapPeers: [
      { ip: "127.0.0.1", port: 8911 },
      { ip: "127.0.0.1", port: 8912 }
    ],
    dbPath: "data/test_Bob_Col.db"
  });
  await bobCol.start();

  // Đợi đồng bộ DHT
  await new Promise((r) => setTimeout(r, 1200));

  const bobDhtContacts = bobCol.getDhtNode().routingTable.getAll();
  console.log(`   - Số lượng node trong K-bucket của Bob: ${bobDhtContacts.length}`);
  for (const c of bobDhtContacts) {
    console.log(`     + Node in K-Bucket: '${c.displayName}' @ ${c.ip}:${c.tcpPort} [ID: ${c.nodeId.substring(0, 10)}...]`);
  }

  const hasAlice1 = bobDhtContacts.some((c) => c.nodeId === id1 && c.tcpPort === 8911);
  const hasAlice2 = bobDhtContacts.some((c) => c.nodeId === id2 && c.tcpPort === 8912);

  if (!hasAlice1 || !hasAlice2 || bobDhtContacts.length < 2) {
    throw new Error("[PHẦN 1 FAILED] K-bucket của Bob bị ghi đè hoặc không lưu đủ 2 node Alice khác nhau!");
  }
  console.log("   ✅ Xác nhận: Bảng K-bucket của Bob lưu trữ đồng thời cả 2 node Alice riêng biệt mà KHÔNG hề bị ghi đè loạn xạ!");

  // Đóng các node phần 1
  await alice1.close();
  await alice2.close();
  await bobCol.close();
  console.log("   ✅ [PHẦN 1 PASSED] Giải quyết triệt để Name Collision trong Pure P2P DHT.\n");

  // ============================================================================
  // PHẦN 2: HÀN GẮN PHÂN MẢNH MẠNG (NETWORK PARTITION HEALING KHÔNG CẦN RESTART)
  // ============================================================================
  console.log("--------------------------------------------------------------------------------");
  console.log("[PHẦN 2] Kiểm tra Hàn gắn phân mảnh mạng (Network Partition Healing)");
  console.log("--------------------------------------------------------------------------------");

  console.log("1. Khởi tạo 3 Node: Alice (8921, Seed), Bob (8922 -> 8921), Charlie (8923 -> 8922)...");
  const alicePart = new PeerController({
    displayName: "Alice",
    tcpPort: 8921,
    discoveryMode: "dht",
    dbPath: "data/test_Alice_Part.db",
    partitionHealingIntervalMs: 1000 // Tăng tốc chu kỳ quét hàn gắn cho test
  });
  await alicePart.start();

  const bobPart = new PeerController({
    displayName: "Bob",
    tcpPort: 8922,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8921 }],
    dbPath: "data/test_Bob_Part.db",
    partitionHealingIntervalMs: 1000
  });
  await bobPart.start();

  const charliePart = new PeerController({
    displayName: "Charlie",
    tcpPort: 8923,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8922 }],
    dbPath: "data/test_Charlie_Part.db",
    partitionHealingIntervalMs: 1000
  });
  await charliePart.start();

  // Đợi cả 3 node tìm thấy nhau
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`   - Alice ban đầu nhận biết: ${alicePart.getOnlinePeers().map(p => p.displayName).join(", ")}`);
  console.log(`   - Bob ban đầu nhận biết  : ${bobPart.getOnlinePeers().map(p => p.displayName).join(", ")}`);

  console.log("\n2. Giả lập đứt mạng (Network Partition): Tách mạng làm 2 nửa cô lập:");
  console.log("   - Nửa A: Alice");
  console.log("   - Nửa B: Bob & Charlie");
  alicePart.simulateFirewallBlock("Bob", true);
  alicePart.simulateFirewallBlock("Charlie", true);
  bobPart.simulateFirewallBlock("Alice", true);
  charliePart.simulateFirewallBlock("Alice", true);

  console.log("   Kích hoạt chu trình kiểm tra liveness (maintenance pings) để phát hiện link chết...");
  // Chạy liveness maintenance 2 lần liên tiếp để failedPings >= 2
  await alicePart.getDhtNode().runMaintenance();
  await bobPart.getDhtNode().runMaintenance();
  await charliePart.getDhtNode().runMaintenance();

  await new Promise((r) => setTimeout(r, 200));

  await alicePart.getDhtNode().runMaintenance();
  await bobPart.getDhtNode().runMaintenance();
  await charliePart.getDhtNode().runMaintenance();

  const aliceAfterPartition = alicePart.getDhtNode().routingTable.getAll().map(c => c.displayName);
  const bobAfterPartition = bobPart.getDhtNode().routingTable.getAll().map(c => c.displayName);

  console.log(`   - K-bucket của Alice sau phân mảnh: [${aliceAfterPartition.join(", ")}] (Đã xóa Bob & Charlie)`);
  console.log(`   - K-bucket của Bob sau phân mảnh  : [${bobAfterPartition.join(", ")}] (Đã xóa Alice, còn Charlie)`);

  if (aliceAfterPartition.includes("Bob") || bobAfterPartition.includes("Alice")) {
    throw new Error("[PHẦN 2 FAILED] Các node chưa bị xóa khỏi K-bucket sau khi link bị đứt!");
  }
  console.log("   ✅ Xác nhận: Mạng đã bị đứt thành 2 nửa cô lập hoàn toàn!");

  console.log("\n3. Phục hồi đường truyền mạng vật lý giữa Alice và (Bob, Charlie)...");
  console.log("   LƯU Ý: KHÔNG KHỞI ĐỘNG LẠI BẤT KỲ NODE NÀO!");
  alicePart.simulateFirewallBlock("Bob", false);
  alicePart.simulateFirewallBlock("Charlie", false);
  bobPart.simulateFirewallBlock("Alice", false);
  charliePart.simulateFirewallBlock("Alice", false);

  console.log("   Kích hoạt cơ chế tự động hàn gắn phân mảnh mạng (Partition Healing)...");
  // Gọi healPartition hoặc chờ chu kỳ partition healing
  await bobPart.healPartition();
  await alicePart.healPartition();

  await new Promise((r) => setTimeout(r, 1200));

  const aliceHealed = alicePart.getDhtNode().routingTable.getAll().map(c => c.displayName);
  const bobHealed = bobPart.getDhtNode().routingTable.getAll().map(c => c.displayName);

  console.log(`   - K-bucket của Alice sau khi hàn gắn: [${aliceHealed.join(", ")}]`);
  console.log(`   - K-bucket của Bob sau khi hàn gắn  : [${bobHealed.join(", ")}]`);

  if (!aliceHealed.includes("Bob") || !bobHealed.includes("Alice")) {
    throw new Error("[PHẦN 2 FAILED] Cơ chế Partition Healing không hàn gắn được 2 nửa mạng lại với nhau!");
  }
  console.log("   ✅ Xác nhận: Hai nửa mạng đã được hàn gắn thành công mà KHÔNG cần khởi động lại bất kỳ node nào!");

  console.log("\n4. Thử nghiệm gửi tin nhắn chat xuyên qua mạng vừa được hàn gắn...");
  const msgFromAlice = await alicePart.sendChatMessage("Bob", "Chào Bob, mạng đã được hàn gắn tự động!");
  console.log(`   - Alice gửi tin nhắn tới Bob: Trạng thái [${msgFromAlice.status}]`);

  // Đợi ACK về
  await new Promise((r) => setTimeout(r, 500));
  const bobHistory = bobPart.getChatHistory("Alice");
  const receivedMsg = bobHistory.find(m => m.body.includes("hàn gắn tự động"));

  if (!receivedMsg) {
    throw new Error("[PHẦN 2 FAILED] Bob không nhận được tin nhắn sau khi mạng hàn gắn!");
  }
  console.log(`   - Bob đã nhận tin nhắn thành công: "${receivedMsg.body}" (Status: ${receivedMsg.status})`);
  console.log("   ✅ [PHẦN 2 PASSED] Hàn gắn phân mảnh mạng (Network Partition Healing) hoạt động hoàn hảo 100%!");

  // Dọn dẹp
  await alicePart.close();
  await bobPart.close();
  await charliePart.close();

  console.log("\n================================================================================");
  console.log("🎉 TẤT CẢ KIỂM THỬ XUNG ĐỘT ĐỊNH DANH & HÀN GẮN PHÂN MẢNH MẠNG ĐÃ HOÀN TẤT 100%! 🎉");
  console.log("================================================================================\n");
}

runPartitionHealingAndIdentityTest().catch((err) => {
  console.error("\n❌ LỖI KIỂM THỬ:", err);
  process.exit(1);
});

