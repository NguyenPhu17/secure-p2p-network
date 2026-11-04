/**
 * TEMPLATE CHO BẢO MẬT (GIAI ĐOẠN 2)
 *
 * File này là khung xương để người phụ trách phần bảo mật cài đặt SecureChannel.
 * Thay thế PlainChannel bằng SecureChannel trong PeerController mà không cần thay đổi bất kỳ logic chat hay UI nào.
 */

import { IChannel, MessageHandler } from "../../common/channel.js";
import { BaseMessage } from "../../common/protocol.js";
import { Logger } from "../../common/logger.js";

export class SecureChannel implements IChannel {
  private receiveHandler: MessageHandler | null = null;

  constructor(
    private listenHost: string,
    private listenPort: number,
    private logger: Logger
  ) {}

  public async init(): Promise<void> {
    // TODO(SECURITY): Khởi tạo TCP Server bảo mật (hoặc TLS/mã hóa ở tầng ứng dụng)
    this.logger.info("SYSTEM", "[TODO-SECURITY] Khởi tạo SecureChannel...");
  }

  public async sendMessage(targetIp: string, targetPort: number, message: BaseMessage): Promise<boolean> {
    /**
     * TODO(SECURITY):
     * 1. Kiểm tra xem đã có Session Key với Target Peer chưa.
     * 2. Nếu chưa: Gửi yêu cầu tới KDC (Registry) để xin Ticket và Session Key.
     * 3. Tiến hành Handshake xác thực 2 chiều với Target Peer.
     * 4. Sinh `nonce` ngẫu nhiên để chống Replay Attack (gán vào message.nonce).
     * 5. Mã hóa `payload` bằng Session Key (thuật toán AES-256-GCM hoặc ChaCha20-Poly1305).
     * 6. Tính toán MAC / Chữ ký số (gán vào message.mac_or_signature).
     * 7. Đóng gói frame TCP và gửi đi.
     */
    this.logger.warn("SYSTEM", "[TODO-SECURITY] sendMessage qua kênh bảo mật chưa được cài đặt.");
    return false;
  }

  public onReceive(handler: MessageHandler): void {
    /**
     * TODO(SECURITY):
     * 1. Khi nhận được frame từ socket TCP:
     * 2. Bóc tách nonce, kiểm tra trong cache nonce để chống Replay.
     * 3. Xác thực tính toàn vẹn (MAC / Chữ ký số) bằng message.mac_or_signature.
     * 4. Giải mã payload bằng Session Key.
     * 5. Truyền message đã giải mã cho handler: this.receiveHandler(decryptedMsg).
     */
    this.receiveHandler = handler;
  }

  public isSecure(): boolean {
    return true; // Kênh đã được mã hóa
  }

  public async close(): Promise<void> {
    // TODO(SECURITY): Hủy các khóa phiên, đóng kết nối an toàn
  }
}

