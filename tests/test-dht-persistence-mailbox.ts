/**
 * Kiểm thử Toàn diện: Sao lưu & Bền vững dữ liệu DHT (Persistence, Replication & Distributed Mailbox)
 *
 * MỤC TIÊU KIỂM CHỨNG:
 * 1. Bền vững dữ liệu DHT (Data Persistence across Node Restart / Churn):
 *    - Dữ liệu cặp Key-Value lưu trên DHT được lưu bền vững vào SQLite (`dht_storage`).
 *    - Khi node tắt hoặc restart, dữ liệu được tự động nạp lại đầy đủ từ SQLite, không bị mất mát.
 * 2. Kademlia Periodic Republishing:
 *    - Node sở hữu dữ liệu tự động phát tán lại DHT_STORE định kỳ tới K node lân cận.
 * 3. Hàng đợi tin nhắn Offline phân tán (Distributed Mailbox via DHT):
 *    - Bob offline. Alice gửi tin nhắn cho Bob.
 *    - Tin nhắn offline được đưa lên DHT dưới dạng Distributed Mailbox (replicate trên Charlie).
 *    - Alice TẮT HOÀN TOÀN (cả Alice và Bob đều offline).
 *    - Bob BẬT LẠI (chỉ kết nối với Charlie, Alice vẫn offline hoàn toàn).
 *    - Bob tự query DHT và kéo tin nhắn về từ Charlie thành công 100%!
 */

import fs from "node:fs";
import { PeerController } from "../peer/peer-controller.js";
import { generateNodeId } from "../peer/dht/dht-types.js";

async function runPersistenceAndMailboxTest() {
  console.log("================================================================================");
  console.log("   KIỂM THỬ: SAO LƯU & BỀN VỮNG DỮ LIỆU DHT (PERSISTENCE & DISTRIBUTED MAILBOX)");
  console.log("================================================================================\n");

  // Dọn dẹp DB test cũ
  for (const name of ["Alice_m3", "Bob_m3", "Charlie_m3"]) {
    const db = `data/dht_${name}.db`;
    if (fs.existsSync(db)) fs.unlinkSync(db);
    if (fs.existsSync(`${db}-wal`)) fs.unlinkSync(`${db}-wal`);
    if (fs.existsSync(`${db}-shm`)) fs.unlinkSync(`${db}-shm`);
  }

  // ============================================================================
  // BƯỚC 1: KHỞI TẠO 3 PEER TRONG MẠNG PURE P2P DHT
  // ============================================================================
  console.log("[BƯỚC 1] Khởi động 3 Peer trong mạng Pure P2P DHT:");
  const alice = new PeerController({
    displayName: "Alice",
    tcpPort: 8801,
    discoveryMode: "dht",
    dbPath: "data/dht_Alice_m3.db"
  });
  await alice.start();

  const bob = new PeerController({
    displayName: "Bob",
    tcpPort: 8802,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8801 }],
    dbPath: "data/dht_Bob_m3.db"
  });
  await bob.start();

  const charlie = new PeerController({
    displayName: "Charlie",
    tcpPort: 8803,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8802 }],
    dbPath: "data/dht_Charlie_m3.db"
  });
  await charlie.start();

  await new Promise((r) => setTimeout(r, 1200));
  console.log("   ✅ Cả 3 node Alice, Bob, Charlie đã online và gia nhập mạng DHT.");

  // ============================================================================
  // BƯỚC 2: KIỂM CHỨNG LƯU TRỮ VÀ BỀN VỮNG DỮ LIỆU PHÂN TÁN (DHT PERSISTENCE)
  // ============================================================================
  console.log("\n[BƯỚC 2] Kiểm thử Bền vững dữ liệu DHT vào SQLite (Data Persistence across Restart):");
  const testKey = generateNodeId("user_profile_alice");
  const testData = {
    bio: "Alice in P2P Wonderland",
    avatar: "https://p2p.network/alice.png",
    rating: 5
  };

  console.log(`   Alice lưu trữ cặp Key-Value lên DHT (Key: ${testKey.substring(0, 10)}...)...`);
  const storeCount = await alice.getDhtNode().store(testKey, testData, 3600000);
  console.log(`   - Dữ liệu đã replicate trên ${storeCount} node.`);

  // Kiểm tra xem Charlie có nhận và lưu vào SQLite không
  const charlieStored = charlie.getStore().getDhtRecord(testKey);
  if (!charlieStored || charlieStored.value.bio !== testData.bio) {
    throw new Error("[BƯỚC 2 FAILED] Charlie chưa nhận hoặc chưa lưu dữ liệu DHT vào SQLite!");
  }
  console.log(`   - Charlie đã lưu dữ liệu vào SQLite: bio='${charlieStored.value.bio}'`);

  console.log("   Tắt Charlie và khởi động lại để kiểm tra phục hồi từ SQLite sau khi Restart...");
  await charlie.close();

  const charlieRevived = new PeerController({
    displayName: "Charlie",
    tcpPort: 8803,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8802 }],
    dbPath: "data/dht_Charlie_m3.db" // Cùng file DB SQLite
  });
  await charlieRevived.start();

  // Kiểm tra ngay trong RAM storage của Charlie sau khi khởi động
  const restoredVal = await charlieRevived.getDhtNode().findValue(testKey);
  if (!restoredVal.found || restoredVal.value?.bio !== testData.bio) {
    throw new Error("[BƯỚC 2 FAILED] Sau khi restart, Charlie không phục hồi được dữ liệu từ SQLite!");
  }
  console.log(`   - Charlie sau khi restart tìm thấy dữ liệu: '${restoredVal.value.bio}'`);
  console.log("✅ [BƯỚC 2 PASSED] Bền vững dữ liệu phân tán (DHT Persistence) hoạt động hoàn hảo!");

  // ============================================================================
  // BƯỚC 3: KIỂM CHỨNG KADEMLIA PERIODIC REPUBLISHING
  // ============================================================================
  console.log("\n[BƯỚC 3] Kiểm thử Kademlia Periodic Republishing:");
  const republishCount = await alice.getDhtNode().runRepublish();
  console.log(`   - Alice đã quét và phát tán lại ${republishCount} bản ghi sở hữu tới K node lân cận.`);
  if (republishCount < 1) {
    throw new Error("[BƯỚC 3 FAILED] runRepublish không quét được dữ liệu sở hữu của Alice!");
  }
  console.log("✅ [BƯỚC 3 PASSED] Cơ chế Periodic Republishing chuẩn Kademlia vận hành chính xác.");

  // ============================================================================
  // BƯỚC 4: HÀNG ĐỢI OFFLINE PHÂN TÁN QUA DISTRIBUTED MAILBOX
  // ============================================================================
  console.log("\n[BƯỚC 4] Kiểm thử Hàng đợi tin nhắn Offline phân tán (Distributed Mailbox via DHT):");
  console.log("   Kịch bản thử thách khắc nghiệt nhất:");
  console.log("   1. Bob tắt máy (Offline).");
  console.log("   2. Alice gửi tin nhắn cho Bob -> Tự động lưu vào Distributed Mailbox trên DHT (replicate qua Charlie).");
  console.log("   3. Alice tắt máy hoàn toàn (Cả Alice và Bob đều offline!).");
  console.log("   4. Bob bật máy lên (kết nối CHỈ với Charlie, Alice vẫn offline).");
  console.log("   5. Bob tự động kéo tin nhắn offline từ Distributed Mailbox trên DHT của Charlie!");

  console.log("\n   1. Tắt Bob...");
  await bob.close();
  // Đợi Bob offline trong routing table
  await alice.getDhtNode().runMaintenance();
  await alice.getDhtNode().runMaintenance();

  console.log("   2. Alice gửi tin nhắn cho Bob khi Bob đang offline...");
  const msgText = "Chào Bob! Đây là tin nhắn offline lưu trên Distributed Mailbox DHT.";
  const sentPending = await alice.sendChatMessage("Bob", msgText);

  if (sentPending.status !== "pending") {
    throw new Error("[BƯỚC 4 FAILED] Tin gửi cho peer offline phải ở trạng thái pending!");
  }
  console.log(`   - Alice đã lưu pending tại SQLite và gửi vào Distributed Mailbox trên DHT.`);

  // Đợi gói DHT_STORE tới Charlie
  await new Promise((r) => setTimeout(r, 600));

  console.log("   3. Tắt hoàn toàn Alice (Alice bây giờ offline hoàn toàn, không thể trực tiếp gửi tin!)...");
  await alice.close();
  console.log("   -> Alice đã đóng hoàn toàn.");

  console.log("   4. Khởi động lại Bob (bootstrap qua Charlie 8803)...");
  const bobRevived = new PeerController({
    displayName: "Bob",
    tcpPort: 8802,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8803 }], // Chỉ kết nối Charlie! Alice vẫn sập!
    dbPath: "data/dht_Bob_m3.db"
  });

  await bobRevived.start();

  console.log("   5. Đang chờ Bob tự động truy vấn Distributed Mailbox trên DHT và kéo tin về...");
  await new Promise((r) => setTimeout(r, 1200));

  const bobHistory = bobRevived.getChatHistory("Alice");
  console.log(`   - Lịch sử tin nhắn của Bob với Alice: ${bobHistory.length} tin.`);
  for (const m of bobHistory) {
    console.log(`     + [${m.sender} ➔ ${m.receiver}]: "${m.body}" [Trạng thái: ${m.status}] [Relayed by: ${m.relayed_by}]`);
  }

  const receivedOfflineMsg = bobHistory.find((m) => m.body === msgText);
  if (!receivedOfflineMsg) {
    throw new Error("[BƯỚC 4 FAILED] Bob không kéo được tin nhắn offline từ Distributed Mailbox trên DHT khi Alice đã sập!");
  }

  if (receivedOfflineMsg.status !== "delivered") {
    throw new Error(`[BƯỚC 4 FAILED] Tin nhắn kéo từ Mailbox trạng thái không phải delivered (trạng thái: ${receivedOfflineMsg.status})`);
  }

  console.log("✅ [BƯỚC 4 PASSED] Bob đã kéo thành công tin nhắn offline từ Distributed Mailbox trên DHT ngay cả khi Alice tắt máy!");

  // Dọn dẹp tài nguyên
  await bobRevived.close();
  await charlieRevived.close();

  console.log("\n================================================================================");
  console.log("🎉 TẤT CẢ KIỂM THỬ SAO LƯU & BỀN VỮNG DỮ LIỆU DHT ĐÃ VƯỢT QUA 100%! 🎉");
  console.log("================================================================================\n");
}

runPersistenceAndMailboxTest().catch((err) => {
  console.error("❌ KIỂM THỬ THẤT BẠI:", err);
  process.exit(1);
});

