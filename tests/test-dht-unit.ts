/**
 * Unit Test: Kademlia DHT Metric, K-Buckets & Routing Table
 */

import { generateNodeId, xorDistance, getBucketIndex } from "../peer/dht/dht-types.js";
import { KBucket } from "../peer/dht/k-bucket.js";
import { RoutingTable } from "../peer/dht/routing-table.js";

function runDhtUnitTest() {
  console.log("================================================================================");
  console.log("   KIỂM THỬ ĐƠN VỊ (UNIT TEST): KADEMLIA DHT METRIC, K-BUCKETS & ROUTING TABLE");
  console.log("================================================================================\n");

  // 1. Kiểm tra phát sinh Node ID 160-bit SHA-1
  console.log("[TEST 1] Kiểm tra Node ID và khoảng cách XOR:");
  const idAlice = generateNodeId("Alice");
  const idBob = generateNodeId("Bob");
  const idCharlie = generateNodeId("Charlie");

  console.log(`   - Alice ID  : ${idAlice} (${idAlice.length} hex chars = 160 bits)`);
  console.log(`   - Bob ID    : ${idBob}`);
  console.log(`   - Charlie ID: ${idCharlie}`);

  if (idAlice.length !== 40 || idBob.length !== 40 || idCharlie.length !== 40) {
    throw new Error("[TEST 1 FAILED] Node ID không đủ 160 bits (40 hex chars)");
  }

  const distAliceBob = xorDistance(idAlice, idBob);
  const distBobAlice = xorDistance(idBob, idAlice);
  const distAliceAlice = xorDistance(idAlice, idAlice);

  if (distAliceAlice !== 0n) {
    throw new Error("[TEST 1 FAILED] Khoảng cách XOR giữa 1 node với chính nó phải bằng 0!");
  }
  if (distAliceBob !== distBobAlice) {
    throw new Error("[TEST 1 FAILED] Khoảng cách XOR phải có tính đối xứng d(x, y) = d(y, x)!");
  }
  console.log(`   - d(Alice, Bob)     = 0x${distAliceBob.toString(16).substring(0, 16)}...`);
  console.log(`   - d(Alice, Alice)   = ${distAliceAlice}`);
  console.log("   ✅ Tính chất đối xứng và đồng nhất của metric XOR đã được xác nhận.");

  // 2. Kiểm tra K-Bucket Index
  console.log("\n[TEST 2] Kiểm tra phân bổ Bucket Index (0..159):");
  const bucketAliceBob = getBucketIndex(idAlice, idBob);
  const bucketAliceCharlie = getBucketIndex(idAlice, idCharlie);
  console.log(`   - Bucket(Alice, Bob)    : Index ${bucketAliceBob}`);
  console.log(`   - Bucket(Alice, Charlie): Index ${bucketAliceCharlie}`);

  if (bucketAliceBob < 0 || bucketAliceBob > 159 || bucketAliceCharlie < 0 || bucketAliceCharlie > 159) {
    throw new Error("[TEST 2 FAILED] Bucket index nằm ngoài khoảng [0, 159]!");
  }
  console.log("   ✅ Bucket index chuẩn xác trong không gian 160-bit.");

  // 3. Kiểm tra KBucket và cơ chế Trục xuất LRU (Eviction)
  console.log("\n[TEST 3] Kiểm tra K-Bucket (Capacity K=3, LRU Eviction):");
  const kbucket = new KBucket(3);

  kbucket.addOrUpdate({ nodeId: "1111", displayName: "Node1", ip: "127.0.0.1", tcpPort: 8001, lastSeen: 1, failedPings: 0 });
  kbucket.addOrUpdate({ nodeId: "2222", displayName: "Node2", ip: "127.0.0.1", tcpPort: 8002, lastSeen: 2, failedPings: 0 });
  kbucket.addOrUpdate({ nodeId: "3333", displayName: "Node3", ip: "127.0.0.1", tcpPort: 8003, lastSeen: 3, failedPings: 0 });

  if (kbucket.size() !== 3 || !kbucket.isFull()) {
    throw new Error("[TEST 3 FAILED] KBucket chưa đạt dung lượng K=3!");
  }

  // Thử thêm node 4 khi cả 3 node cũ đều healthy (failedPings = 0)
  const fullRes = kbucket.addOrUpdate({ nodeId: "4444", displayName: "Node4", ip: "127.0.0.1", tcpPort: 8004, lastSeen: 4, failedPings: 0 });
  if (fullRes.status !== "FULL") {
    throw new Error("[TEST 3 FAILED] Bucket đầy không được thêm node mới nếu node cũ còn sống!");
  }

  // Giả lập node cũ nhất (Node1) bị lỗi ping
  const oldest = kbucket.getOldest()!;
  oldest.failedPings = 1;

  // Thêm lại node 4 -> phải trục xuất Node1
  const evictRes = kbucket.addOrUpdate({ nodeId: "4444", displayName: "Node4", ip: "127.0.0.1", tcpPort: 8004, lastSeen: 4, failedPings: 0 });
  if (evictRes.status !== "EVICTED_AND_ADDED" || (evictRes as any).evicted?.displayName !== "Node1") {
    throw new Error("[TEST 3 FAILED] Không trục xuất đúng node cũ nhất bị lỗi!");
  }
  console.log("   ✅ Cơ chế LRU Eviction của K-Bucket hoạt động hoàn hảo.");

  // 4. Kiểm tra RoutingTable và Tìm K-Nodes gần nhất (Closest Nodes Lookup)
  console.log("\n[TEST 4] Kiểm tra RoutingTable 160 Buckets & Tìm K nodes gần nhất:");
  const rt = new RoutingTable(idAlice, 5);

  rt.addOrUpdate({ nodeId: idBob, displayName: "Bob", ip: "127.0.0.1", tcpPort: 8002, lastSeen: Date.now(), failedPings: 0 });
  rt.addOrUpdate({ nodeId: idCharlie, displayName: "Charlie", ip: "127.0.0.1", tcpPort: 8003, lastSeen: Date.now(), failedPings: 0 });
  rt.addOrUpdate({ nodeId: generateNodeId("David"), displayName: "David", ip: "127.0.0.1", tcpPort: 8004, lastSeen: Date.now(), failedPings: 0 });
  rt.addOrUpdate({ nodeId: generateNodeId("Eve"), displayName: "Eve", ip: "127.0.0.1", tcpPort: 8005, lastSeen: Date.now(), failedPings: 0 });

  if (rt.size() !== 4) {
    throw new Error(`[TEST 4 FAILED] Số node trong RoutingTable không khớp (mong đợi 4, nhận ${rt.size()})`);
  }

  const closestToCharlie = rt.getClosestNodes(idCharlie, 2);
  if (closestToCharlie.length !== 2 || closestToCharlie[0].displayName !== "Charlie") {
    throw new Error("[TEST 4 FAILED] Thuật toán tìm K-nodes gần nhất không trả về chính Charlie ở vị trí đầu!");
  }
  console.log(`   - 2 nodes gần Charlie nhất: ${closestToCharlie.map(c => c.displayName).join(", ")}`);
  console.log("   ✅ Giải thuật Closest Nodes Lookup theo khoảng cách XOR chính xác tuyệt đối.");

  console.log("\n================================================================================");
  console.log("🎉 TẤT CẢ UNIT TESTS CỦA KADEMLIA DHT ĐÃ HOÀN TOÀN VƯỢT QUA! 🎉");
  console.log("================================================================================\n");
}

runDhtUnitTest();

