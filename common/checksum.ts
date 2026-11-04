/**
 * Module tính toán Checksum / Hash cho Chunk và File
 * Giai đoạn 1: Dùng thuật toán Checksum nhanh CRC32/DJB2-based.
 * Tối ưu RAM: Xử lý stream từng đoạn nhỏ 64KB, không bao giờ load toàn bộ file lớn vào bộ nhớ.
 *
 * TODO(SECURITY): Trong Giai đoạn 2, thay thế hàm băm này bằng:
 * 1. crypto.createHash('sha256') cho toàn file.
 * 2. HMAC-SHA256 hoặc Chữ ký số (Digital Signature) bằng Private Key của Peer gửi.
 */

import fs from "node:fs";

/**
 * Thuật toán tính checksum 32-bit nhanh cho Buffer (DJB2a biến thể)
 */
export function calculateChecksum(buffer: Buffer): string {
  let hash = 5381;
  for (let i = 0; i < buffer.length; i++) {
    hash = ((hash << 5) + hash) ^ buffer[i];
    hash = hash >>> 0; // Chuyển thành số nguyên 32-bit không dấu
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Tính checksum toàn bộ file trên đĩa theo luồng Stream (Tối ưu RAM)
 * Không bao giờ load cả file 50MB vào RAM.
 */
export async function calculateFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let hash = 5381;
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

    stream.on("data", (chunk: any) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let i = 0; i < buf.length; i++) {
        hash = ((hash << 5) + hash) ^ buf[i];
        hash = hash >>> 0;
      }
    });

    stream.on("end", () => {
      resolve(hash.toString(16).padStart(8, "0"));
    });

    stream.on("error", (err) => {
      reject(err);
    });
  });
}
