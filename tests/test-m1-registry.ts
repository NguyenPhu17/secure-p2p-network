/**
 * Automated Verification Script for Milestone 1 (M1)
 * Kiểm thử: Đăng ký, Từ chối trùng tên, Heartbeat, Phát hiện timeout và Discovery.
 */

import net from "node:net";
import { FrameDecoder, encodeFrame } from "../common/framing.js";
import { BaseMessage, MessageType } from "../common/protocol.js";

const REGISTRY_PORT = 7000;
const REGISTRY_HOST = "127.0.0.1";

function createPeerClient(name: string, tcpPort: number) {
  const socket = new net.Socket();
  const decoder = new FrameDecoder();
  const messagesReceived: BaseMessage[] = [];

  return {
    socket,
    messagesReceived,
    connect(): Promise<void> {
      return new Promise((resolve, reject) => {
        socket.connect(REGISTRY_PORT, REGISTRY_HOST, () => resolve());
        socket.on("error", (err) => reject(err));
        socket.on("data", (chunk) => {
          decoder.push(chunk, (msg) => {
            messagesReceived.push(msg);
          });
        });
      });
    },
    send(msg: BaseMessage) {
      socket.write(encodeFrame(msg));
    },
    waitForMessage(predicate: (m: BaseMessage) => boolean, timeoutMs = 4000): Promise<BaseMessage> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          clearInterval(poller);
          reject(new Error(`Timeout ${timeoutMs}ms waiting for message condition`));
        }, timeoutMs);

        const poller = setInterval(() => {
          const found = messagesReceived.find(predicate);
          if (found) {
            clearTimeout(timer);
            clearInterval(poller);
            resolve(found);
          }
        }, 50);
      });
    },
    close() {
      socket.destroy();
    }
  };
}

async function runTest() {
  console.log("=== BẮT ĐẦU KIỂM THỬ MỐC 1 (M1): REGISTRY & DISCOVERY ===");

  // 1. Peer Alice kết nối và đăng ký
  console.log("\n[TEST 1] Peer Alice đăng ký...");
  const alice = createPeerClient("Alice", 8001);
  await alice.connect();

  const registerAlice: BaseMessage = {
    type: MessageType.REGISTER,
    message_id: crypto.randomUUID(),
    sender: "Alice",
    receiver: "REGISTRY",
    seq: 1,
    timestamp: Date.now(),
    payload: { ip: "127.0.0.1", tcpPort: 8001 },
    nonce: null,
    mac_or_signature: null
  };
  alice.send(registerAlice);

  const aliceAck = await alice.waitForMessage((m) => m.type === MessageType.REGISTER_ACK);
  if (aliceAck.payload.status === "OK") {
    console.log("✅ [TEST 1 PASSED] Alice đăng ký thành công!");
  } else {
    throw new Error(`[TEST 1 FAILED] Alice đăng ký thất bại: ${JSON.stringify(aliceAck.payload)}`);
  }

  // 2. Peer Bob kết nối và đăng ký -> Alice phải nhận PEER_JOINED
  console.log("\n[TEST 2] Peer Bob đăng ký & Kiểm tra Discovery...");
  const bob = createPeerClient("Bob", 8002);
  await bob.connect();

  const registerBob: BaseMessage = {
    type: MessageType.REGISTER,
    message_id: crypto.randomUUID(),
    sender: "Bob",
    receiver: "REGISTRY",
    seq: 1,
    timestamp: Date.now(),
    payload: { ip: "127.0.0.1", tcpPort: 8002 },
    nonce: null,
    mac_or_signature: null
  };
  bob.send(registerBob);

  const bobAck = await bob.waitForMessage((m) => m.type === MessageType.REGISTER_ACK);
  const aliceSawBob = await alice.waitForMessage(
    (m) => m.type === MessageType.PEER_JOINED && m.payload.displayName === "Bob"
  );

  console.log(`✅ [TEST 2 PASSED] Bob đăng ký thành công (danh sách peer trong ACK: ${bobAck.payload.peers.length})`);
  console.log(`✅ [TEST 2 PASSED] Alice nhận thông báo PEER_JOINED về Bob: ${aliceSawBob.payload.displayName}`);

  // 3. Thử đăng ký trùng tên Alice (Imposter) -> Phải bị REJECTED
  console.log("\n[TEST 3] Thử đăng ký trùng tên 'Alice'...");
  const fakeAlice = createPeerClient("Alice", 8099);
  await fakeAlice.connect();

  const registerFake: BaseMessage = {
    type: MessageType.REGISTER,
    message_id: crypto.randomUUID(),
    sender: "Alice",
    receiver: "REGISTRY",
    seq: 1,
    timestamp: Date.now(),
    payload: { ip: "127.0.0.1", tcpPort: 8099 },
    nonce: null,
    mac_or_signature: null
  };
  fakeAlice.send(registerFake);

  const fakeAck = await fakeAlice.waitForMessage((m) => m.type === MessageType.REGISTER_ACK);
  if (fakeAck.payload.status === "REJECTED") {
    console.log(`✅ [TEST 3 PASSED] Registry từ chối trùng tên chính xác: ${fakeAck.payload.reason}`);
  } else {
    throw new Error(`[TEST 3 FAILED] Registry không từ chối trùng tên!`);
  }
  fakeAlice.close();

  // 4. Kiểm tra Heartbeat từ Bob
  console.log("\n[TEST 4] Kiểm tra gửi Heartbeat...");
  const heartbeatMsg: BaseMessage = {
    type: MessageType.HEARTBEAT,
    message_id: crypto.randomUUID(),
    sender: "Bob",
    receiver: "REGISTRY",
    seq: 2,
    timestamp: Date.now(),
    payload: {},
    nonce: null,
    mac_or_signature: null
  };
  bob.send(heartbeatMsg);

  const hbAck = await bob.waitForMessage((m) => m.type === MessageType.HEARTBEAT_ACK);
  console.log(`✅ [TEST 4 PASSED] Nhận Heartbeat ACK thành công: serverTime = ${hbAck.payload.serverTime}`);

  // 5. Kiểm tra phát hiện ngắt kết nối (Alice đóng socket)
  console.log("\n[TEST 5] Alice ngắt kết nối -> Bob phải nhận thông báo PEER_LEFT...");
  alice.close();

  const bobSawAliceLeft = await bob.waitForMessage(
    (m) => m.type === MessageType.PEER_LEFT && m.payload.displayName === "Alice",
    6000
  );
  console.log(`✅ [TEST 5 PASSED] Bob nhận thông báo PEER_LEFT của Alice: lý do '${bobSawAliceLeft.payload.reason}'`);

  bob.close();
  console.log("\n🎉 TOÀN BỘ CÁC BÀI TEST MỐC 1 (M1) ĐÃ VƯỢT QUA HOÀN HẢO! 🎉");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("❌ Test thất bại:", err);
  process.exit(1);
});

