/**
 * Interface Channel - Lớp truyền thông thống nhất duy nhất giữa các Node
 * Mọi việc gửi/nhận qua mạng đều đi qua interface này.
 *
 * Giai đoạn 1: PlainChannel (truyền plaintext JSON qua raw TCP socket).
 * Giai đoạn 2: TODO(SECURITY) Thay bằng SecureChannel mà KHÔNG sửa đổi logic nghiệp vụ.
 */

import { BaseMessage } from "./protocol.js";

export type MessageHandler = (message: BaseMessage, fromAddress?: { ip: string; port: number }) => void;

export interface IChannel {
  /**
   * Khởi động server/kênh truyền thông
   */
  init(): Promise<void>;

  /**
   * Gửi message tới một địa chỉ đích (IP:Port)
   * @param targetIp Địa chỉ IP đích
   * @param targetPort Cổng TCP đích
   * @param message Tin nhắn chuẩn BaseMessage
   * @returns true nếu gửi thành công
   */
  sendMessage(targetIp: string, targetPort: number, message: BaseMessage): Promise<boolean>;

  /**
   * Đăng ký hàm nhận message khi có gói tin tới
   */
  onReceive(handler: MessageHandler): void;

  /**
   * Đóng toàn bộ socket và giải phóng tài nguyên
   */
  close(): Promise<void>;

  /**
   * Kiểm tra xem kênh truyền này đã có mã hóa bảo mật hay chưa
   * PlainChannel trả về false; SecureChannel (Giai đoạn 2) sẽ trả về true.
   */
  isSecure(): boolean;
}

