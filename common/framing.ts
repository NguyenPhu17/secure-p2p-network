/**
 * Xử lý đóng gói (Framing) và giải mã luồng dữ liệu TCP
 * Cơ chế: 4 Bytes UInt32BE quy định độ dài + UTF-8 JSON Buffer
 * Tối ưu RAM: Tái sử dụng buffer và giải phóng ngay khi bóc tách frame xong.
 */

import { BaseMessage } from "./protocol.js";

const MAX_FRAME_SIZE = 10 * 1024 * 1024; // 10MB tối đa cho 1 frame phòng ngừa tấn công cạn kiệt RAM

/**
 * Đóng gói message thành Buffer TCP: [4 bytes Length (BE)] + [JSON bytes]
 */
export function encodeFrame(message: BaseMessage): Buffer {
  const jsonStr = JSON.stringify(message);
  const payloadBuffer = Buffer.from(jsonStr, "utf-8");
  const length = payloadBuffer.length;

  if (length > MAX_FRAME_SIZE) {
    throw new Error(`Frame size exceeds maximum allowed limit: ${length} > ${MAX_FRAME_SIZE}`);
  }

  const frame = Buffer.allocUnsafe(4 + length);
  frame.writeUInt32BE(length, 0);
  payloadBuffer.copy(frame, 4);
  return frame;
}

/**
 * Bộ giải mã TCP Stream thành từng BaseMessage hoàn chỉnh
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Đẩy dữ liệu mới từ TCP socket 'data' event vào bộ đệm và bóc tách các frame hoàn chỉnh
   * @param chunk Buffer nhận được từ TCP socket
   * @param onMessage Callback được gọi khi bóc tách thành công một BaseMessage
   * @param onError Callback khi gặp lỗi định dạng / JSON
   */
  public push(
    chunk: Buffer,
    onMessage: (msg: BaseMessage) => void,
    onError?: (err: Error) => void
  ): void {
    // Nối chunk mới vào buffer hiện tại
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      // Đọc 4 bytes độ dài đầu tiên
      const expectedLength = this.buffer.readUInt32BE(0);

      if (expectedLength > MAX_FRAME_SIZE) {
        const err = new Error(`Frame length ${expectedLength} exceeds maximum limit ${MAX_FRAME_SIZE}. Dropping buffer.`);
        if (onError) onError(err);
        this.buffer = Buffer.alloc(0); // Xóa buffer để bảo vệ RAM
        return;
      }

      // Kiểm tra xem đã nhận đủ toàn bộ gói tin chưa
      const totalFrameSize = 4 + expectedLength;
      if (this.buffer.length < totalFrameSize) {
        // Chưa nhận đủ gói tin, chờ chunk tiếp theo từ TCP stream
        break;
      }

      // Đã đủ 1 frame hoàn chỉnh: Trích xuất payload
      const jsonBuffer = this.buffer.subarray(4, totalFrameSize);
      // Cắt bỏ frame đã đọc khỏi buffer, giữ lại phần dữ liệu của frame kế tiếp
      this.buffer = Buffer.from(this.buffer.subarray(totalFrameSize));

      try {
        const jsonStr = jsonBuffer.toString("utf-8");
        const msg = JSON.parse(jsonStr) as BaseMessage;
        onMessage(msg);
      } catch (err: any) {
        if (onError) {
          onError(new Error(`Failed to parse frame JSON: ${err.message}`));
        }
      }
    }
  }

  /**
   * Reset bộ đệm khi socket đóng hoặc rớt mạng
   */
  public reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

