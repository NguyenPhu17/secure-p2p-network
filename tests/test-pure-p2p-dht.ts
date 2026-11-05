/**
 * Kịch bản Kiểm thử Toàn diện Mạng P2P Phi Tập Trung Hoàn Toàn (Pure P2P DHT Kademlia)
 *
 * MỤC TIÊU KIỂM CHỨNG:
 * 1. KHÔNG SỬ DỤNG BẤT KỲ REGISTRY SERVER NÀO (Zero SPOF - Single Point of Failure).
 * 2. Tự động khám phá đa bên thông qua DHT Iterative Lookup:
 *    - Alice khởi tạo làm Seed Node (cổng 8601).
 *    - Bob gia nhập qua Alice (cổng 8602, bootstrap Alice 8601).
 *    - Charlie gia nhập CHỈ qua Bob (cổng 8603, bootstrap Bob 8602).
 *    -> Charlie tự động khám phá ra Alice thông qua DHT Routing Table của Bob!
 * 3. Chat 1-1 và File transfer qua TCP direct giữa các peer được khám phá bởi DHT.
 * 4. Kiểm chứng khả năng chịu lỗi (Fault Tolerance) khi Seed Node chết:
 *    - Tắt hoàn toàn Alice (Node khởi nguồn).
 *    - Bob và Charlie tự phát hiện Alice chết qua DHT Liveness Pings phi tập trung.
 *    - Bob và Charlie vẫn tiếp tục chat và gửi file thông suốt (Mạng không bị sập hay mất liên lạc).
 * 5. Tự phục hồi (Self-Healing) & Hàng đợi tin nhắn Offline:
 *    - Charlie gửi tin cho Alice khi Alice đang offline -> lưu trạng thái pending.
 *    - Alice sống lại, bootstrap qua Charlie -> Charlie phát hiện Alice online và tự flush tin pending thành công.
 */

import fs from "node:fs";
import path from "node:path";
import { PeerController } from "../peer/peer-controller.js";
import { calculateFileChecksum } from "../common/checksum.js";

async function runPureP2PDhtTest() {
  console.log("================================================================================");
  console.log("   KIỂM THỬ MẠNG PHI TẬP TRUNG HOÀN TOÀN: PURE P2P DHT (KADEMLIA - ZERO SPOF)");
  console.log("================================================================================\n");

  const testDir = "tests/temp_dht";
  const downloadsAlice = "downloads/test_dht_alice";
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  if (fs.existsSync(downloadsAlice)) fs.rmSync(downloadsAlice, { recursive: true, force: true });

  // Dọn dẹp DB test cũ
  for (const name of ["Alice", "Bob", "Charlie"]) {
    const db = `data/dht_${name}.db`;
    if (fs.existsSync(db)) fs.unlinkSync(db);
  }

  // ============================================================================
  // BƯỚC 1: KHỞI TẠO 3 PEER VỚI DHT BOOTSTRAP (KHÔNG CÓ BẤT KỲ REGISTRY NÀO!)
  // ============================================================================
  console.log("[BƯỚC 1] Khởi động 3 Peer ở chế độ PURE P2P DHT (Không Registry):");
  console.log("   1. Alice: Seed Node (Port 8601)");
  console.log("   2. Bob  : Bootstrap từ Alice (Port 8602 -> 8601)");
  console.log("   3. Charlie: Bootstrap CHỈ từ Bob (Port 8603 -> 8602) -> Tìm thấy Alice qua DHT!");

  const alice = new PeerController({
    displayName: "Alice",
    tcpPort: 8601,
    discoveryMode: "dht",
    dbPath: "data/dht_Alice.db",
    downloadDir: downloadsAlice
  });

  await alice.start();
  console.log(`   ✅ Alice khởi động thành công (Node ID: ${alice.getNodeId().substring(0, 10)}...)`);

  const bob = new PeerController({
    displayName: "Bob",
    tcpPort: 8602,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8601 }],
    dbPath: "data/dht_Bob.db"
  });

  await bob.start();
  console.log(`   ✅ Bob khởi động và bootstrap qua Alice thành công (Node ID: ${bob.getNodeId().substring(0, 10)}...)`);

  const charlie = new PeerController({
    displayName: "Charlie",
    tcpPort: 8603,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8602 }], // Chỉ bootstrap qua Bob!
    dbPath: "data/dht_Charlie.db"
  });

  await charlie.start();
  console.log(`   ✅ Charlie khởi động và bootstrap qua Bob thành công (Node ID: ${charlie.getNodeId().substring(0, 10)}...)`);

  // Đợi 1.5s để tiến trình DHT Iterative Lookup & Announce hoàn tất giữa cả 3 node
  console.log("\n   Đang chờ DHT Iterative Lookup & Routing Tables đồng bộ...");
  await new Promise((r) => setTimeout(r, 1500));

  const alicePeers = alice.getOnlinePeers().map((p) => p.displayName);
  const bobPeers = bob.getOnlinePeers().map((p) => p.displayName);
  const charliePeers = charlie.getOnlinePeers().map((p) => p.displayName);

  console.log(`   - Alice nhận biết (${alicePeers.length}): ${alicePeers.join(", ")}`);
  console.log(`   - Bob nhận biết   (${bobPeers.length}): ${bobPeers.join(", ")}`);
  console.log(`   - Charlie nhận biết (${charliePeers.length}): ${charliePeers.join(", ")}`);

  if (!alicePeers.includes("Bob") || !alicePeers.includes("Charlie")) {
    throw new Error("[BƯỚC 1 FAILED] Alice chưa nhận biết đủ Bob và Charlie qua DHT!");
  }
  if (!bobPeers.includes("Alice") || !bobPeers.includes("Charlie")) {
    throw new Error("[BƯỚC 1 FAILED] Bob chưa nhận biết đủ Alice và Charlie qua DHT!");
  }
  if (!charliePeers.includes("Alice") || !charliePeers.includes("Bob")) {
    throw new Error("[BƯỚC 1 FAILED] Charlie (chỉ bootstrap qua Bob) chưa khám phá được Alice qua DHT!");
  }

  console.log("✅ [BƯỚC 1 PASSED] Cả 3 node đã tự động khám phá lẫn nhau 100% qua DHT Kademlia!");

  // ============================================================================
  // BƯỚC 2: NHẮN TIN TRỰC TIẾP GIỮA CÁC PEER ĐƯỢC KHÁM PHÁ QUA DHT
  // ============================================================================
  console.log("\n[BƯỚC 2] Nhắn tin đồng thời giữa các Peer thông qua địa chỉ tìm được từ DHT:");
  const msg1 = await alice.sendChatMessage("Bob", "Xin chào Bob qua mạng DHT!");
  const msg2 = await bob.sendChatMessage("Charlie", "Xin chào Charlie qua mạng DHT!");
  const msg3 = await charlie.sendChatMessage("Alice", "Xin chào Alice qua mạng DHT!");

  await new Promise((r) => setTimeout(r, 800));

  const hAlice = alice.getChatHistory("Bob");
  const hBob = bob.getChatHistory("Charlie");
  const hCharlie = charlie.getChatHistory("Alice");

  if (hAlice[0]?.status !== "delivered" || hBob[0]?.status !== "delivered" || hCharlie[0]?.status !== "delivered") {
    throw new Error("[BƯỚC 2 FAILED] Tin nhắn không nhận được ACK delivered qua kênh Direct P2P!");
  }

  console.log(`   - Alice -> Bob     : '${msg1.body}' [${hAlice[0].status}]`);
  console.log(`   - Bob -> Charlie   : '${msg2.body}' [${hBob[0].status}]`);
  console.log(`   - Charlie -> Alice : '${msg3.body}' [${hCharlie[0].status}]`);
  console.log("✅ [BƯỚC 2 PASSED] Giao tiếp tin nhắn văn bản và ACK 2 chiều hoàn tất.");

  // ============================================================================
  // BƯỚC 3: TRUYỀN FILE CHUNK PHÂN ĐOẠN 64KB & KIỂM TRA HASH TOÀN VẸN
  // ============================================================================
  console.log("\n[BƯỚC 3] Truyền file nhị phân phân đoạn 64KB từ Charlie -> Alice qua DHT:");
  const testFilePath = path.join(testDir, "dht_document.pdf");
  const dummyBuffer = Buffer.alloc(180 * 1024); // 180 KB (~3 chunks 64KB)
  for (let i = 0; i < dummyBuffer.length; i++) dummyBuffer[i] = i % 256;
  fs.writeFileSync(testFilePath, dummyBuffer);
  const originalHash = await calculateFileChecksum(testFilePath);

  const transferResult = await charlie.sendFile("Alice", testFilePath);
  if (!transferResult.success) {
    throw new Error(`[BƯỚC 3 FAILED] Gửi file thất bại: ${transferResult.error}`);
  }

  await new Promise((r) => setTimeout(r, 1000));

  const receivedFilePath = path.join(downloadsAlice, "dht_document.pdf");
  if (!fs.existsSync(receivedFilePath)) {
    throw new Error(`[BƯỚC 3 FAILED] Alice chưa nhận được file tại ${receivedFilePath}`);
  }
  const receivedHash = await calculateFileChecksum(receivedFilePath);
  if (originalHash !== receivedHash) {
    throw new Error(`[BƯỚC 3 FAILED] Checksum hash file không khớp (Gốc: ${originalHash}, Nhận: ${receivedHash})`);
  }
  console.log(`   - Gửi file thành công: 180KB, Checksum: ${receivedHash}`);
  console.log("✅ [BƯỚC 3 PASSED] Truyền file nhị phân qua P2P Direct Socket toàn vẹn tuyệt đối.");

  // ============================================================================
  // BƯỚC 4: KIỂM CHỨNG LOẠI BỎ SPOF KHI SEED NODE (ALICE) BỊ SẬP (CRASH)
  // ============================================================================
  console.log("\n[BƯỚC 4] Kiểm chứng loại bỏ Single Point of Failure (SPOF):");
  console.log("   Đang tắt đột ngột node khởi nguồn (Alice 8601)...");
  await alice.close();
  console.log("   -> Alice đã đóng kết nối.");

  console.log("   Đang kích hoạt DHT liveness maintenance trên Bob & Charlie...");
  // Chạy liveness check trên Bob và Charlie để phát hiện Alice không phản hồi ping
  await bob.getDhtNode().runMaintenance();
  await charlie.getDhtNode().runMaintenance();
  // Lần 2 để vượt ngưỡng 2 lần fail
  await bob.getDhtNode().runMaintenance();
  await charlie.getDhtNode().runMaintenance();

  const bobKnownAfterAliceCrash = bob.getOnlinePeers().map((p) => p.displayName);
  const charlieKnownAfterAliceCrash = charlie.getOnlinePeers().map((p) => p.displayName);

  console.log(`   - Danh sách online của Bob sau khi Alice chết: ${bobKnownAfterAliceCrash.join(", ") || "(Trống)"}`);
  console.log(`   - Danh sách online của Charlie sau khi Alice chết: ${charlieKnownAfterAliceCrash.join(", ") || "(Trống)"}`);

  if (bobKnownAfterAliceCrash.includes("Alice") || charlieKnownAfterAliceCrash.includes("Alice")) {
    throw new Error("[BƯỚC 4 FAILED] Bob và Charlie chưa đánh dấu Alice là OFFLINE sau khi Alice chết!");
  }

  console.log("   Kiểm tra xem Bob và Charlie có còn chat được với nhau khi Seed Node chết?");
  const bobToCharlieMsg = await bob.sendChatMessage("Charlie", "Alice đã sập, nhưng mạng DHT chúng mình vẫn sống!");
  await new Promise((r) => setTimeout(r, 600));

  const bobHistory = bob.getChatHistory("Charlie");
  if (bobHistory[0]?.status !== "delivered") {
    throw new Error("[BƯỚC 4 FAILED] Bob không gửi được tin nhắn cho Charlie khi Alice chết!");
  }
  console.log(`   - Bob -> Charlie   : '${bobToCharlieMsg.body}' [Trạng thái: ${bobHistory[0].status}]`);
  console.log("✅ [BƯỚC 4 PASSED] Xác nhận loại bỏ hoàn toàn SPOF! Mạng không có điểm lỗi đơn lẻ.");

  // ============================================================================
  // BƯỚC 5: HÀNG ĐỢI OFFLINE & TỰ PHỤC HỒI KHI SEED NODE GIA NHẬP LẠI
  // ============================================================================
  console.log("\n[BƯỚC 5] Kiểm tra Hàng đợi tin Offline và Khả năng Tự Phục Hồi (Self-Healing):");
  console.log("   Charlie gửi tin nhắn cho Alice khi Alice đang OFFLINE...");
  const charlieOfflineMsg = await charlie.sendChatMessage("Alice", "Chào Alice, chúc mừng bạn đã quay trở lại mạng!");
  if (charlieOfflineMsg.status !== "pending") {
    throw new Error("[BƯỚC 5 FAILED] Tin nhắn gửi cho node offline phải ở trạng thái pending!");
  }
  console.log(`   - Tin nhắn lưu trong SQLite của Charlie: [Trạng thái: ${charlieOfflineMsg.status}]`);

  console.log("   Khởi động lại Alice (bây giờ bootstrap từ Charlie 8603)...");
  const aliceRevived = new PeerController({
    displayName: "Alice",
    tcpPort: 8601,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8603 }], // Bootstrap qua Charlie!
    dbPath: "data/dht_Alice.db",
    downloadDir: downloadsAlice
  });

  await aliceRevived.start();
  console.log("   Đang chờ Charlie phát hiện Alice online và tự động gửi bù tin pending...");
  await new Promise((r) => setTimeout(r, 1500));

  const charlieHistoryAfterRevival = charlie.getChatHistory("Alice");
  const deliveredMsg = charlieHistoryAfterRevival.find((m) => m.message_id === charlieOfflineMsg.message_id);

  console.log(`   - Trạng thái tin nhắn sau khi Alice online: [${deliveredMsg?.status}]`);
  if (deliveredMsg?.status !== "delivered") {
    throw new Error(`[BƯỚC 5 FAILED] Tin nhắn offline không được flush thành delivered (trạng thái: ${deliveredMsg?.status})`);
  }

  console.log("✅ [BƯỚC 5 PASSED] Mạng tự phục hồi thành công. Tin nhắn offline đã được gửi bù và xác nhận!");

  // Dọn dẹp tài nguyên
  await aliceRevived.close();
  await bob.close();
  await charlie.close();

  console.log("\n================================================================================");
  console.log("🎉 TẤT CẢ KỊCH BẢN KIỂM THỬ PURE P2P DHT (KADEMLIA) ĐÃ VƯỢT QUA 100%! 🎉");
  console.log("================================================================================\n");
}

runPureP2PDhtTest().catch((err) => {
  console.error("❌ KIỂM THỬ THẤT BẠI:", err);
  process.exit(1);
});
