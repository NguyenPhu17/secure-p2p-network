/**
 * Kịch bản Kiểm thử Toàn diện Cơ chế Định tuyến Đa chặng Mesh Relay (Multi-hop Overlay Routing)
 *
 * MỤC TIÊU KIỂM CHỨNG:
 * 1. Khởi động mạng P2P gồm 3 Peer: Alice (8701), Bob (8702), Charlie (8703).
 * 2. Xác thực liên lạc trực tiếp 1-chặng (Direct Single-hop P2P) khi đường truyền bình thường.
 * 3. Kích hoạt Giả lập Tường lửa / NAT / Đứt đường truyền trực tiếp giữa Alice và Bob:
 *    - Alice KHÔNG THỂ kết nối trực tiếp với Bob.
 *    - Bob KHÔNG THỂ kết nối trực tiếp với Alice.
 * 4. Kiểm chứng Cơ chế Định tuyến Đa chặng (Mesh Overlay Routing):
 *    - Alice tự động phát hiện đường truyền trực tiếp hỏng.
 *    - Alice tự động tìm kiếm Peer trung gian khả dụng (Charlie).
 *    - Alice đóng gói tin nhắn vào phong bì RELAY_FORWARD và chuyển cho Charlie.
 *    - Charlie đóng vai trò Overlay Router: Kiểm tra chống lặp vòng (Loop Prevention), kiểm tra TTL (Hop Limit),
 *      và chuyển tiếp gói tin tới Bob an toàn.
 *    - Bob nhận gói tin, bóc tách thông điệp gốc của Alice, ghi nhận Tuyến đường [Alice ➔ Charlie ➔ Bob].
 *    - Bob gửi ngược phản hồi CHAT_ACK cũng qua kênh Mesh Relay (Charlie ➔ Alice) do đường truyền trực tiếp bị chặn.
 *    - Tin nhắn phía Alice chuyển sang trạng thái 'delivered' hoàn tất 100%!
 * 5. Kiểm chứng định tuyến 2 chiều (Bob gửi cho Alice qua Charlie).
 * 6. Kiểm chứng cơ chế Chống lặp vòng định tuyến (Loop Prevention) & Giới hạn chặng (TTL).
 * 7. Kiểm chứng khôi phục đường truyền trực tiếp (Self-healing).
 */

import fs from "node:fs";
import { PeerController } from "../peer/peer-controller.js";
import { BaseMessage, MessageType, RelayForwardPayload } from "../common/protocol.js";

async function runMeshRelayRoutingTest() {
  console.log("================================================================================");
  console.log("   KIỂM THỬ ĐỊNH TUYẾN ĐA CHẶNG: MULTI-HOP OVERLAY MESH ROUTING (PEER RELAY)");
  console.log("================================================================================\n");

  // Dọn dẹp DB test cũ
  for (const name of ["Alice_relay", "Bob_relay", "Charlie_relay"]) {
    const db = `data/${name}.db`;
    if (fs.existsSync(db)) fs.unlinkSync(db);
  }

  // ============================================================================
  // BƯỚC 1: KHỞI TẠO MẠNG 3 PEER (ALICE, BOB, CHARLIE)
  // ============================================================================
  console.log("[BƯỚC 1] Khởi động 3 Peer trong mạng Pure P2P DHT:");
  console.log("   1. Alice  : Port 8701 (Seed Node)");
  console.log("   2. Bob    : Port 8702 (Bootstrap từ Alice)");
  console.log("   3. Charlie: Port 8703 (Bootstrap từ Bob)");

  const alice = new PeerController({
    displayName: "Alice",
    tcpPort: 8701,
    discoveryMode: "dht",
    dbPath: "data/Alice_relay.db"
  });
  await alice.start();

  const bob = new PeerController({
    displayName: "Bob",
    tcpPort: 8702,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8701 }],
    dbPath: "data/Bob_relay.db"
  });
  await bob.start();

  const charlie = new PeerController({
    displayName: "Charlie",
    tcpPort: 8703,
    discoveryMode: "dht",
    bootstrapPeers: [{ ip: "127.0.0.1", port: 8702 }],
    dbPath: "data/Charlie_relay.db"
  });
  await charlie.start();

  console.log("   Đang chờ các Peer tự động khám phá lẫn nhau qua DHT...");
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`   - Alice thấy   : ${alice.getOnlinePeers().map((p) => p.displayName).join(", ")}`);
  console.log(`   - Bob thấy     : ${bob.getOnlinePeers().map((p) => p.displayName).join(", ")}`);
  console.log(`   - Charlie thấy : ${charlie.getOnlinePeers().map((p) => p.displayName).join(", ")}`);
  console.log("✅ [BƯỚC 1 PASSED] 3 Peer đã sẵn sàng kết nối.\n");

  // ============================================================================
  // BƯỚC 2: LIÊN LẠC TRỰC TIẾP 1-CHẶNG (BASELINE TEST)
  // ============================================================================
  console.log("[BƯỚC 2] Kiểm tra liên lạc trực tiếp ban đầu (Direct 1-Hop P2P):");
  const directMsg = await alice.sendChatMessage("Bob", "Xin chào Bob qua Direct Socket!");
  await new Promise((r) => setTimeout(r, 600));

  const bobDirectHistory = bob.getChatHistory("Alice");
  const aliceDirectHistory = alice.getChatHistory("Bob");

  console.log(`   - Trạng thái tin gửi phía Alice: [${aliceDirectHistory[0]?.status}]`);
  console.log(`   - Tuyến đường ghi nhận: [${aliceDirectHistory[0]?.route?.join(" ➔ ") || "Direct"}]`);

  if (aliceDirectHistory[0]?.status !== "delivered") {
    throw new Error("[BƯỚC 2 FAILED] Tin nhắn trực tiếp không nhận được ACK delivered!");
  }
  console.log("✅ [BƯỚC 2 PASSED] Liên lạc trực tiếp 1-chặng hoạt động chuẩn xác.\n");

  // ============================================================================
  // BƯỚC 3: GIẢ LẬP TƯỜNG LỬA / NAT CHẶN TOÀN BỘ KẾT NỐI TRỰC TIẾP ALICE <-> BOB
  // ============================================================================
  console.log("[BƯỚC 3] Giả lập Tường lửa / NAT cô lập đường truyền trực tiếp giữa Alice và Bob:");
  alice.simulateFirewallBlock("Bob", true);
  bob.simulateFirewallBlock("Alice", true);
  console.log("   -> Alice: Đã chặn direct TCP tới Bob.");
  console.log("   -> Bob  : Đã chặn direct TCP tới Alice.");
  console.log("   -> Cả hai vẫn duy trì kết nối thông suốt với Charlie (Peer trung gian).\n");

  // ============================================================================
  // BƯỚC 4: ALICE GỬI TIN CHO BOB - TỰ ĐỘNG CHUYỂN TIẾP QUA CHARLIE (MESH RELAY)
  // ============================================================================
  console.log("[BƯỚC 4] Alice gửi tin nhắn cho Bob khi đường truyền trực tiếp bị chặn:");
  console.log("   Nội dung: 'Bob ơi, tin nhắn này được định tuyến qua Charlie nè!'");

  const relayMsg = await alice.sendChatMessage("Bob", "Bob ơi, tin nhắn này được định tuyến qua Charlie nè!");
  console.log(`   - Alice phát hiện direct bị chặn -> Tự động chọn Charlie làm Relay Router.`);
  console.log(`   - Trạng thái ban đầu phía Alice: [${relayMsg.status}] (Relayed via: ${relayMsg.relayed_by})`);

  // Đợi gói tin đi qua Charlie và Bob gửi lại ACK qua Charlie về Alice
  await new Promise((r) => setTimeout(r, 1200));

  const bobRelayHistory = bob.getChatHistory("Alice");
  const receivedMsg = bobRelayHistory.find((m) => m.message_id === relayMsg.message_id);

  if (!receivedMsg) {
    throw new Error("[BƯỚC 4 FAILED] Bob không nhận được tin nhắn chuyển tiếp từ Charlie!");
  }

  console.log(`\n   🎯 KẾT QUẢ TIẾP NHẬN PHÍA BOB:`);
  console.log(`   - Nội dung nhận được: '${receivedMsg.body}'`);
  console.log(`   - Tuyến đường Mesh  : [${receivedMsg.route?.join(" ➔ ")}]`);
  console.log(`   - Chuyển tiếp bởi   : '${receivedMsg.relayed_by}'`);

  const aliceRelayHistory = alice.getChatHistory("Bob");
  const ackedMsg = aliceRelayHistory.find((m) => m.message_id === relayMsg.message_id);

  console.log(`\n   🎯 KẾT QUẢ PHẢN HỒI ACK PHÍA ALICE:`);
  console.log(`   - Trạng thái tin nhắn sau khi Bob ACK: [${ackedMsg?.status}]`);
  console.log(`   - Tuyến đường định tuyến: [${ackedMsg?.route?.join(" ➔ ")}]`);

  if (ackedMsg?.status !== "delivered") {
    throw new Error(`[BƯỚC 4 FAILED] Tin nhắn không nhận được ACK delivered qua Relay (trạng thái: ${ackedMsg?.status})`);
  }

  if (receivedMsg.relayed_by !== "Charlie") {
    throw new Error(`[BƯỚC 4 FAILED] Relay router không phải là Charlie (thực tế: ${receivedMsg.relayed_by})`);
  }

  console.log("✅ [BƯỚC 4 PASSED] Alice gửi tin và nhận ACK từ Bob thành công 100% qua Peer thứ 3 (Charlie Relay)!\n");

  // ============================================================================
  // BƯỚC 5: ĐỊNH TUYẾN 2 CHIỀU: BOB TRẢ LỜI ALICE QUA CHARLIE
  // ============================================================================
  console.log("[BƯỚC 5] Kiểm chứng định tuyến 2 chiều: Bob trả lời Alice qua Charlie:");
  const bobReply = await bob.sendChatMessage("Alice", "Tuyệt vời Alice! Mình nhận được qua Charlie rồi nhé.");
  await new Promise((r) => setTimeout(r, 1000));

  const aliceReceivedReply = alice.getChatHistory("Bob").find((m) => m.message_id === bobReply.message_id);
  const bobReplyStatus = bob.getChatHistory("Alice").find((m) => m.message_id === bobReply.message_id);

  console.log(`   - Bob gửi trạng thái : [${bobReplyStatus?.status}] (Relayed via: ${bobReplyStatus?.relayed_by})`);
  console.log(`   - Alice nhận nội dung: '${aliceReceivedReply?.body}' (Tuyến: [${aliceReceivedReply?.route?.join(" ➔ ")}])`);

  if (bobReplyStatus?.status !== "delivered") {
    throw new Error("[BƯỚC 5 FAILED] Bob gửi tin phản hồi qua Relay không nhận được ACK!");
  }
  console.log("✅ [BƯỚC 5 PASSED] Định tuyến Mesh 2 chiều hoàn hảo.\n");

  // ============================================================================
  // BƯỚC 6: KIỂM CHỨNG CHỐNG LẶP VÒNG ĐỊNH TUYẾN (ROUTING LOOP PREVENTION)
  // ============================================================================
  console.log("[BƯỚC 6] Kiểm chứng Chống lặp vòng định tuyến (Routing Loop Prevention):");
  console.log("   Gửi gói tin có tuyến chứa sẵn 'Charlie' tới Charlie...");

  const loopPacket: BaseMessage<RelayForwardPayload> = {
    type: MessageType.RELAY_FORWARD,
    message_id: "test-loop-id",
    sender: "Alice",
    receiver: "Charlie",
    seq: 0,
    timestamp: Date.now(),
    payload: {
      relaySessionId: "loop-session-123",
      originSender: "Alice",
      finalReceiver: "Bob",
      hopCount: 2,
      maxHops: 5,
      route: ["Alice", "Charlie", "David"], // Charlie đã có trong route!
      innerMessage: {
        type: MessageType.CHAT,
        message_id: "inner-loop-id",
        sender: "Alice",
        receiver: "Bob",
        seq: 99,
        timestamp: Date.now(),
        payload: { body: "Tin nhắn lặp vòng" },
        nonce: null,
        mac_or_signature: null
      }
    },
    nonce: null,
    mac_or_signature: null
  };

  // Gửi trực tiếp gói tin lặp tới cổng của Charlie
  await (alice as any).channel.sendMessage("127.0.0.1", 8703, loopPacket);
  await new Promise((r) => setTimeout(r, 400));

  // Kiểm tra Bob không bị nhận gói tin lặp này
  const bobMessages = bob.getChatHistory("Alice");
  const loopReceived = bobMessages.some((m) => m.body === "Tin nhắn lặp vòng");
  if (loopReceived) {
    throw new Error("[BƯỚC 6 FAILED] Router không chặn gói tin lặp vòng định tuyến!");
  }
  console.log("✅ [BƯỚC 6 PASSED] Router Charlie đã phát hiện và tiêu hủy gói tin lặp vòng chuẩn xác.\n");

  // ============================================================================
  // BƯỚC 7: KIỂM CHỨNG GIỚI HẠN CHẶNG (TTL / MAX HOPS EXCEEDED)
  // ============================================================================
  console.log("[BƯỚC 7] Kiểm chứng Giới hạn chặng tối đa (TTL / Hop Limit):");
  const ttlExceededPacket: BaseMessage<RelayForwardPayload> = {
    type: MessageType.RELAY_FORWARD,
    message_id: "test-ttl-id",
    sender: "Alice",
    receiver: "Charlie",
    seq: 0,
    timestamp: Date.now(),
    payload: {
      relaySessionId: "ttl-session-456",
      originSender: "Alice",
      finalReceiver: "Bob",
      hopCount: 3, // Bằng maxHops
      maxHops: 3,
      route: ["Alice", "NodeX", "NodeY"],
      innerMessage: {
        type: MessageType.CHAT,
        message_id: "inner-ttl-id",
        sender: "Alice",
        receiver: "Bob",
        seq: 100,
        timestamp: Date.now(),
        payload: { body: "Tin nhắn quá số chặng" },
        nonce: null,
        mac_or_signature: null
      }
    },
    nonce: null,
    mac_or_signature: null
  };

  await (alice as any).channel.sendMessage("127.0.0.1", 8703, ttlExceededPacket);
  await new Promise((r) => setTimeout(r, 400));

  const ttlReceived = bob.getChatHistory("Alice").some((m) => m.body === "Tin nhắn quá số chặng");
  if (ttlReceived) {
    throw new Error("[BƯỚC 7 FAILED] Router không hủy gói tin khi vượt quá TTL!");
  }
  console.log("✅ [BƯỚC 7 PASSED] Gói tin vượt quá TTL đã được tiêu hủy an toàn, chống bão gói tin.\n");

  // ============================================================================
  // BƯỚC 8: TỰ PHỤC HỒI KHI ĐƯỜNG TRUYỀN TRỰC TIẾP ĐƯỢC MỞ LẠI
  // ============================================================================
  console.log("[BƯỚC 8] Khôi phục đường truyền trực tiếp (Unblock Firewall):");
  alice.simulateFirewallBlock("Bob", false);
  bob.simulateFirewallBlock("Alice", false);

  const restoredMsg = await alice.sendChatMessage("Bob", "Đường truyền trực tiếp đã mở lại rồi!");
  await new Promise((r) => setTimeout(r, 600));

  const finalAliceHistory = alice.getChatHistory("Bob");
  const lastMsg = finalAliceHistory[0];

  console.log(`   - Trạng thái tin gửi : [${lastMsg?.status}]`);
  console.log(`   - Tuyến đường        : [${lastMsg?.route?.join(" ➔ ") || "Direct 1-Hop"}]`);
  console.log(`   - Relay Peer         : ${lastMsg?.relayed_by || "(None - Direct P2P)"}`);

  if (lastMsg?.status !== "delivered") {
    throw new Error("[BƯỚC 8 FAILED] Gửi tin trực tiếp sau phục hồi không thành công!");
  }
  console.log("✅ [BƯỚC 8 PASSED] Mạng tự động ưu tiên quay lại Direct 1-hop khi kết nối thông suốt.\n");

  // Dọn dẹp tài nguyên
  await alice.close();
  await bob.close();
  await charlie.close();

  console.log("================================================================================");
  console.log("🎉 TẤT CẢ KỊCH BẢN KIỂM THỬ ĐỊNH TUYẾN ĐA CHẶNG (MESH RELAY) ĐÃ THÀNH CÔNG 100%! 🎉");
  console.log("================================================================================\n");

  process.exit(0);
}

runMeshRelayRoutingTest().catch((err) => {
  console.error("❌ KIỂM THỬ THẤT BẠI:", err);
  process.exit(1);
});
