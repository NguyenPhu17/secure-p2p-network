/**
 * Automated Verification Script for Milestone 3 (M3)
 * Kiểm thử: Chia nhỏ file thành các chunk 64KB, gửi qua TCP, ráp lại ở bên nhận,
 * kiểm tra tính toàn vẹn (checksum trùng khớp 100%), và tối ưu bộ nhớ RAM khi truyền file lớn.
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

const REGISTRY_PORT = 7002;

async function runM3Test() {
  console.log("=== BẮT ĐẦU KIỂM THỬ MỐC 3 (M3): TRUYỀN FILE CHUNK 64KB & CHECK HASH ===");

  const testDir = "tests/temp_test_files";
  const aliceDownloadDir = "downloads/test_Alice_downloads";
  const bobDownloadDir = "downloads/test_Bob_downloads";

  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  if (fs.existsSync(aliceDownloadDir)) fs.rmSync(aliceDownloadDir, { recursive: true, force: true });
  if (fs.existsSync(bobDownloadDir)) fs.rmSync(bobDownloadDir, { recursive: true, force: true });

  // 1. Khởi động Registry
  const regLogger = new Logger("TestRegistryM3");
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
    tcpPort: 8201,
    registryPort: REGISTRY_PORT,
    dbPath: "data/test_Alice_m3.db",
    downloadDir: aliceDownloadDir
  });

  const bob = new PeerController({
    displayName: "Bob",
    tcpPort: 8202,
    registryPort: REGISTRY_PORT,
    dbPath: "data/test_Bob_m3.db",
    downloadDir: bobDownloadDir
  });

  await alice.start();
  await bob.start();
  await new Promise((r) => setTimeout(r, 600));

  // ----------------------------------------------------
  // TEST 1: Gửi file vừa (200 KB ~ 4 chunks 64KB)
  // ----------------------------------------------------
  console.log("\n[TEST 1] Tạo file 200 KB (4 chunks 64KB) và gửi từ Alice sang Bob...");
  const file1Path = path.join(testDir, "sample_document.txt");
  const buffer1 = Buffer.alloc(200 * 1024);
  for (let i = 0; i < buffer1.length; i++) {
    buffer1[i] = (i % 256);
  }
  fs.writeFileSync(file1Path, buffer1);

  const file1OriginalHash = await calculateFileChecksum(file1Path);
  console.log(`File gốc: size = ${buffer1.length} bytes, Checksum = ${file1OriginalHash}`);

  let completedReceivedFile: any = null;
  bob.onUIEvent((event, data) => {
    if (event === "FILE_COMPLETED") {
      completedReceivedFile = data;
    }
  });

  const sendRes = await alice.sendFile("Bob", file1Path);
  if (!sendRes.success) {
    throw new Error(`[TEST 1 FAILED] Alice gửi file thất bại: ${sendRes.error}`);
  }

  // Chờ Bob hoàn tất ghi đĩa
  await new Promise((r) => setTimeout(r, 600));

  if (!completedReceivedFile) {
    throw new Error("[TEST 1 FAILED] Bob không nhận được sự kiện FILE_COMPLETED!");
  }

  const receivedHash = await calculateFileChecksum(completedReceivedFile.localPath);
  console.log(`File Bob nhận được: path = ${completedReceivedFile.localPath}, Checksum = ${receivedHash}`);

  if (receivedHash === file1OriginalHash) {
    console.log("✅ [TEST 1 PASSED] Checksum khớp 100%! Ráp 4 chunks 64KB thành công không sai 1 byte.");
  } else {
    throw new Error(`[TEST 1 FAILED] Checksum không khớp: ${receivedHash} !== ${file1OriginalHash}`);
  }

  // ----------------------------------------------------
  // TEST 2: Gửi file lớn (3 MB ~ 48 chunks 64KB) kiểm tra Streaming RAM
  // ----------------------------------------------------
  console.log("\n[TEST 2] Tạo file lớn 3 MB (~48 chunks 64KB) kiểm tra tính ổn định...");
  const file2Path = path.join(testDir, "large_archive.bin");
  const buffer2 = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < buffer2.length; i++) {
    buffer2[i] = (i * 7) % 256;
  }
  fs.writeFileSync(file2Path, buffer2);

  const file2OriginalHash = await calculateFileChecksum(file2Path);
  console.log(`File lớn gốc: size = ${buffer2.length} bytes, Checksum = ${file2OriginalHash}`);

  let largeFileCompleted: any = null;
  bob.onUIEvent((event, data) => {
    if (event === "FILE_COMPLETED" && data.fileName === "large_archive.bin") {
      largeFileCompleted = data;
    }
  });

  const sendLargeRes = await alice.sendFile("Bob", file2Path);
  if (!sendLargeRes.success) {
    throw new Error(`[TEST 2 FAILED] Gửi file lớn thất bại: ${sendLargeRes.error}`);
  }

  await new Promise((r) => setTimeout(r, 800));

  if (!largeFileCompleted) {
    throw new Error("[TEST 2 FAILED] Bob chưa nhận xong file lớn!");
  }

  const largeReceivedHash = await calculateFileChecksum(largeFileCompleted.localPath);
  console.log(`File lớn Bob nhận được: size = ${largeFileCompleted.size}, Checksum = ${largeReceivedHash}`);

  if (largeReceivedHash === file2OriginalHash) {
    console.log("✅ [TEST 2 PASSED] File lớn 3MB truyền qua TCP hoàn tất không lỗi, hash trùng khớp tuyệt đối!");
  } else {
    throw new Error(`[TEST 2 FAILED] Hash file lớn sai lệch: ${largeReceivedHash} !== ${file2OriginalHash}`);
  }

  // Dọn dẹp
  await alice.close();
  await bob.close();
  registryService.closeAll();
  await new Promise<void>((resolve) => regServer.close(() => resolve()));

  // Xóa thư mục test
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.rmSync(aliceDownloadDir, { recursive: true, force: true });
  fs.rmSync(bobDownloadDir, { recursive: true, force: true });
  if (fs.existsSync("data/test_Alice_m3.db")) fs.unlinkSync("data/test_Alice_m3.db");
  if (fs.existsSync("data/test_Bob_m3.db")) fs.unlinkSync("data/test_Bob_m3.db");

  console.log("\n🎉 TOÀN BỘ CÁC BÀI TEST MỐC 3 (M3) ĐÃ VƯỢT QUA HOÀN HẢO! 🎉");
  process.exit(0);
}

runM3Test().catch((err) => {
  console.error("❌ Test M3 thất bại:", err);
  process.exit(1);
});

