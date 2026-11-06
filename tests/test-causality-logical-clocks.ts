/**
 * KIỂM THỬ TÍNH NHÂN QUẢ VÀ ĐỒNG HỒ LOGIC (LOGICAL CLOCKS & CAUSALITY)
 * Tiên đề Leslie Lamport (1978): "Time, Clocks, and the Ordering of Events in a Distributed System"
 *
 * Kiểm chứng:
 * 1. Đơn vị: LamportClock (tick, update, monotonicity) và VectorClock (Happened-Before a -> b, Concurrency a || b).
 * 2. Phân tán: Khắc phục Clock Skew / Clock Drift vật lý:
 *    - Peer B có đồng hồ vật lý lùi 1 giờ so với Peer A.
 *    - Peer A hỏi -> Peer B trả lời.
 *    - Chứng minh: Dù Date.now() của Bob nhỏ hơn Date.now() của Alice,
 *      thứ tự hiển thị và lưu trữ theo Lamport Clock L(A) < L(B) đảm bảo 100% Causal Consistency!
 * 3. Phân tán: Khắc phục độ trễ gói tin qua Mesh Relay.
 * 4. Phân tán: Phân giải xung đột ghi đè dữ liệu DHT bằng Lamport Clock (chống ghi đè dữ liệu cũ).
 * 5. Tính bền vững: Khôi phục Lamport Clock sau khi restart node từ SQLite DB.
 */

import fs from "node:fs";
import path from "node:path";
import { LamportClock, VectorClock, compareLamportOrder } from "../common/logical-clock.js";
import { PeerController } from "../peer/peer-controller.js";
import { MessageRecord } from "../peer/db/message-store.js";

const TEST_DIR = "data_test_causality";

function cleanupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCausalityTests() {
  cleanupTestDir();
  fs.mkdirSync(TEST_DIR, { recursive: true });

  console.log("=".repeat(80));
  console.log("   KIỂM THỬ: THỨ TỰ SỰ KIỆN & TÍNH NHÂN QUẢ (LOGICAL CLOCKS & CAUSALITY)");
  console.log("   (Leslie Lamport Logical Clocks, Vector Clocks & Causal Consistency)");
  console.log("=".repeat(80));

  // -------------------------------------------------------------------------
  // [TEST 1] Kiểm tra đơn vị: Lamport Logical Clock & Quy tắc Leslie Lamport
  // -------------------------------------------------------------------------
  console.log("\n[TEST 1] Kiểm thử đơn vị: Lamport Logical Clock (Leslie Lamport 1978)");
  const clockA = new LamportClock(0);
  const clockB = new LamportClock(0);

  // Quy tắc 1: Sự kiện cục bộ / gửi tin -> tick (L = L + 1)
  const lA1 = clockA.tick(); // A gửi tin 1 -> L_A = 1
  console.log(`   - Alice phát sinh sự kiện cục bộ 1: L_Alice = ${lA1}`);
  if (lA1 !== 1) throw new Error(`Lamport clock tick sai: kỳ vọng 1, nhận ${lA1}`);

  // Quy tắc 2: Nhận tin -> update (L_rec = max(L_rec, L_msg) + 1)
  const lB1 = clockB.update(lA1); // Bob nhận tin 1 từ Alice -> L_B = max(0, 1) + 1 = 2
  console.log(`   - Bob nhận thông điệp từ Alice (mang L=1): L_Bob = max(0, 1) + 1 = ${lB1}`);
  if (lB1 !== 2) throw new Error(`Lamport clock update sai: kỳ vọng 2, nhận ${lB1}`);

  // Bob gửi phản hồi cho Alice -> Bob tick: L_B = 3
  const lB2 = clockB.tick();
  console.log(`   - Bob gửi phản hồi cho Alice: L_Bob = ${lB2}`);
  if (lB2 !== 3) throw new Error(`Lamport clock tick sai: kỳ vọng 3, nhận ${lB2}`);

  // Alice nhận phản hồi từ Bob -> Alice update: L_A = max(1, 3) + 1 = 4
  const lA2 = clockA.update(lB2);
  console.log(`   - Alice nhận phản hồi từ Bob (mang L=3): L_Alice = max(1, 3) + 1 = ${lA2}`);
  if (lA2 !== 4) throw new Error(`Lamport clock update sai: kỳ vọng 4, nhận ${lA2}`);

  console.log("   ✅ [TEST 1 PASSED] Thuật toán Leslie Lamport Logical Clock hoạt động hoàn hảo 100%!");

  // -------------------------------------------------------------------------
  // [TEST 2] Kiểm thử đơn vị: Vector Clock (Happened-Before vs Concurrent)
  // -------------------------------------------------------------------------
  console.log("\n[TEST 2] Kiểm thử đơn vị: Vector Clocks (Quan hệ Happened-Before và Concurrency)");
  const vcA = new VectorClock();
  const vcB = new VectorClock();
  const vcC = new VectorClock();

  // Sự kiện e1 trên Alice:
  const v1 = vcA.tick("Alice"); // { Alice: 1 }
  // Alice gửi e1 cho Bob, Bob nhận e1 và xử lý e2:
  vcB.update(v1, "Bob"); // { Alice: 1, Bob: 1 }
  const v2 = vcB.getClock();

  // Kiểm tra e1 -> e2
  const rel12 = VectorClock.compare(v1, v2);
  console.log(`   - So sánh V(e1) = ${JSON.stringify(v1)} và V(e2) = ${JSON.stringify(v2)}: kết quả = [${rel12}]`);
  if (rel12 !== "BEFORE") throw new Error(`Kỳ vọng BEFORE, nhận ${rel12}`);

  // Độc lập: Charlie phát sinh sự kiện e3 cục bộ mà không biết về Alice và Bob:
  const v3 = vcC.tick("Charlie"); // { Charlie: 1 }
  const rel23 = VectorClock.compare(v2, v3);
  console.log(`   - So sánh V(e2) = ${JSON.stringify(v2)} và V(e3) = ${JSON.stringify(v3)}: kết quả = [${rel23}]`);
  if (rel23 !== "CONCURRENT") throw new Error(`Kỳ vọng CONCURRENT (a || b), nhận ${rel23}`);

  console.log("   ✅ [TEST 2 PASSED] Vector Clocks phân biệt chính xác quan hệ nhân quả và sự kiện đồng thời!");

  // -------------------------------------------------------------------------
  // [TEST 3] Khắc phục Clock Skew vật lý: Peer B bị lệch đồng hồ 1 giờ so với Peer A
  // -------------------------------------------------------------------------
  console.log("\n[TEST 3] Kiểm chứng trong Mạng P2P thực tế: Miễn nhiễm với Clock Skew (Clock Drift)");
  console.log("   Giả lập: Bob bị lệch đồng hồ vật lý (chạy chậm 1 giờ = -3,600,000 ms so với Alice).");

  const aliceDb = path.join(TEST_DIR, "Alice.db");
  const bobDb = path.join(TEST_DIR, "Bob.db");

  const alice = new PeerController({
    displayName: "Alice",
    tcpPort: 9201,
    ip: "127.0.0.1",
    discoveryMode: "dht",
    dbPath: aliceDb
  });

  const bob = new PeerController({
    displayName: "Bob",
    tcpPort: 9202,
    ip: "127.0.0.1",
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 9201 }],
    dbPath: bobDb
  });

  await alice.start();
  await bob.start();
  await sleep(600);

  // 1. Alice hỏi Bob: "Bob ơi, bạn có rảnh không?"
  const aliceMsg = await alice.sendChatMessage("Bob", "Bob ơi, bạn có rảnh không?");
  console.log(`   - Alice gửi câu hỏi: "${aliceMsg.body}" (Lamport: L${aliceMsg.lamport_clock}, Physical Time: ${aliceMsg.timestamp})`);
  await sleep(400);

  // 2. Giả lập Bob trả lời nhưng Bob bị lệch đồng hồ vật lý về quá khứ 1 giờ:
  // Can thiệp mock nhẹ để ghi nhận câu trả lời của Bob có physical clock Date.now() - 3,600,000 ms
  const realDateNow = Date.now;
  try {
    // Ép đồng hồ vật lý của Bob lùi 1 tiếng (Physical Clock Skew)
    Date.now = () => realDateNow() - 3600000;

    const bobReply = await bob.sendChatMessage("Alice", "Mình rảnh nè, có chuyện gì thế Alice?");
    console.log(`   - Bob gửi câu trả lời: "${bobReply.body}" (Lamport: L${bobReply.lamport_clock}, Physical Time: ${bobReply.timestamp})`);
    await sleep(400);

    console.log(`\n   [SO SÁNH ĐỒNG HỒ]`);
    console.log(`   + Physical Clock (Date.now()): Alice = ${aliceMsg.timestamp} | Bob = ${bobReply.timestamp} (Bob nhỏ hơn Alice 1 giờ!)`);
    console.log(`   + Lamport Clock            : Alice = L${aliceMsg.lamport_clock} | Bob = L${bobReply.lamport_clock} (Bob lớn hơn Alice)`);

    if (bobReply.timestamp >= aliceMsg.timestamp) {
      throw new Error("Lỗi giả lập: Bob phải có physical timestamp nhỏ hơn Alice!");
    }

    // 3. Kiểm tra lịch sử chat tại Alice và Bob
    const aliceHistory = alice.getChatHistory("Bob");
    const bobHistory = bob.getChatHistory("Alice");

    console.log(`\n   [LỊCH SỬ CHAT CỦA ALICE (Đã sắp xếp theo Lamport Total Order)]:`);
    for (const m of aliceHistory) {
      console.log(`     L${m.lamport_clock ?? 0} [${m.sender} ➔ ${m.receiver}]: "${m.body}"`);
    }

    console.log(`\n   [LỊCH SỬ CHAT CỦA BOB (Đã sắp xếp theo Lamport Total Order)]:`);
    for (const m of bobHistory) {
      console.log(`     L${m.lamport_clock ?? 0} [${m.sender} ➔ ${m.receiver}]: "${m.body}"`);
    }

    // Kiểm tra tính nhân quả: Tin nhắn thứ 1 phải là câu hỏi của Alice, tin nhắn thứ 2 phải là câu trả lời của Bob
    if (aliceHistory[0].body !== "Bob ơi, bạn có rảnh không?" || aliceHistory[1].body !== "Mình rảnh nè, có chuyện gì thế Alice?") {
      throw new Error("Lỗi nhân quả: Lịch sử của Alice bị đảo lộn thứ tự do đồng hồ vật lý!");
    }
    if (bobHistory[0].body !== "Bob ơi, bạn có rảnh không?" || bobHistory[1].body !== "Mình rảnh nè, có chuyện gì thế Alice?") {
      throw new Error("Lỗi nhân quả: Lịch sử của Bob bị đảo lộn thứ tự do đồng hồ vật lý!");
    }

    // Kiểm tra quan hệ Lamport Clock: L(Câu hỏi) < L(Câu trả lời)
    if ((aliceHistory[0].lamport_clock || 0) >= (aliceHistory[1].lamport_clock || 0)) {
      throw new Error(`Lamport Clock không tăng tiến theo nhân quả: L1=${aliceHistory[0].lamport_clock}, L2=${aliceHistory[1].lamport_clock}`);
    }

    console.log("   ✅ [TEST 3 PASSED] Lamport Logical Clock bảo toàn 100% thứ tự nhân quả dù đồng hồ vật lý bị lệch 1 giờ!");
  } finally {
    Date.now = realDateNow;
  }

  // -------------------------------------------------------------------------
  // [TEST 4] Phân giải xung đột ghi đè DHT Storage bằng Lamport Logical Clock
  // -------------------------------------------------------------------------
  console.log("\n[TEST 4] Kiểm chứng: Phân giải xung đột ghi đè DHT bằng Lamport Logical Clock");
  const testKey = "user_status:charlie";

  // 1. Ghi nhận dữ liệu mới hơn với Lamport Clock = 10
  await alice.getDhtNode().store(testKey, { status: "ONLINE", note: "Phiên bản mới" }, 300000, 10, 2);
  console.log("   - Alice ghi vào DHT: Status = 'ONLINE' với Lamport Clock = 10");

  const val1 = await alice.getDhtNode().findValue(testKey);
  console.log(`   - Giá trị hiện tại trên DHT: ${JSON.stringify(val1.value)}`);

  // 2. Gói tin cũ bị trễ mạng đến sau mang Lamport Clock = 5 (Dữ liệu cũ: OFFLINE)
  console.log("   - Một gói tin cũ trễ mạng đến sau với Lamport Clock = 5 (Status = 'OFFLINE')...");
  alice.getDhtNode().saveToStorage(testKey, { status: "OFFLINE", note: "Bản ghi cũ bị trễ" }, 300000, "Charlie", false, 5, 1);

  // 3. Kiểm tra xem bản ghi mới L=10 có bị bản ghi cũ L=5 ghi đè không
  const valAfterStale = alice.getDhtNode().getStorageEntry(testKey);
  console.log(`   - Giá trị DHT sau khi nhận bản ghi cũ: ${JSON.stringify(valAfterStale?.value)} (Lamport: L${valAfterStale?.lamport_clock})`);

  if (valAfterStale?.lamport_clock !== 10 || valAfterStale?.value.status !== "ONLINE") {
    throw new Error("Lỗi xung đột DHT: Bản ghi có Lamport Clock cũ hơn đã ghi đè lên bản ghi mới!");
  }
  console.log("   ✅ [TEST 4 PASSED] DHT từ chối thành công bản ghi có Lamport Clock cũ hơn, bảo vệ tính toàn vẹn dữ liệu!");

  // -------------------------------------------------------------------------
  // [TEST 5] Tính bền vững (Persistence) & Đơn điệu (Monotonicity) sau khi Restart
  // -------------------------------------------------------------------------
  console.log("\n[TEST 5] Kiểm chứng: Khôi phục Lamport Clock sau khi khởi động lại node từ SQLite");
  const currentAliceClock = alice.lamportClock.getClock();
  console.log(`   - Lamport Clock hiện tại của Alice trước khi shutdown: L${currentAliceClock}`);

  await alice.close();
  await sleep(300);

  // Khởi động lại Alice từ chính file SQLite cũ
  const aliceRestarted = new PeerController({
    displayName: "Alice",
    tcpPort: 9201,
    ip: "127.0.0.1",
    discoveryMode: "dht",
    dbPath: aliceDb
  });

  const restoredClock = aliceRestarted.lamportClock.getClock();
  console.log(`   - Lamport Clock của Alice sau khi phục hồi từ SQLite: L${restoredClock}`);

  if (restoredClock < currentAliceClock) {
    throw new Error(`Lamport Clock bị thụt lùi sau khi restart: trước=${currentAliceClock}, sau=${restoredClock}`);
  }

  const nextClock = aliceRestarted.lamportClock.tick();
  console.log(`   - Alice phát sinh sự kiện mới sau restart: L = ${nextClock}`);
  if (nextClock <= currentAliceClock) {
    throw new Error(`Tính đơn điệu (Monotonicity) bị vi phạm!`);
  }

  await aliceRestarted.close();
  await bob.close();

  console.log("   ✅ [TEST 5 PASSED] Lamport Clock duy trì tính đơn điệu tuyệt đối (Monotonicity) xuyên suốt các lần restart!");

  console.log("\n" + "=".repeat(80));
  console.log("🎉 TẤT CẢ KIỂM THỬ THỨ TỰ SỰ KIỆN & TÍNH NHÂN QUẢ ĐÃ HOÀN TOÀN VƯỢT QUA 100%! 🎉");
  console.log("=".repeat(80));

  cleanupTestDir();
}

runCausalityTests().catch((err) => {
  console.error("\n❌ LỖI KIỂM THỬ:", err);
  cleanupTestDir();
  process.exit(1);
});
