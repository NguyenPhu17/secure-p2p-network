/**
 * JwtService - Cấp phát và xác thực JSON Web Token (HMAC-SHA256)
 * Hoàn toàn sử dụng module crypto tiêu chuẩn của Node.js, không cần thư viện bên thứ 3.
 */

import crypto from "node:crypto";

export interface JwtPayload {
  userId: string;
  username: string;
  displayName: string;
  nodePort: number;
  exp?: number;
  iat?: number;
  [key: string]: any;
}

export class JwtService {
  // Khóa bí mật HMAC ký token (Đọc từ ENV hoặc dùng khóa mặc định an toàn)
  private static SECRET =
    process.env.JWT_SECRET || "p2p_secure_network_jwt_secret_key_2026_super_safe_zero_spof";

  /**
   * Ký và tạo chuỗi JWT Token có thời hạn
   * @param payload Dữ liệu định danh người dùng
   * @param expiresInSeconds Thời gian sống của token (Mặc định: 1800s = 30 phút)
   */
  public static sign(payload: JwtPayload, expiresInSeconds: number = 1800): string {
    const header = { alg: "HS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const fullPayload: JwtPayload = {
      ...payload,
      iat: now,
      exp: now + expiresInSeconds
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
    const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");

    const dataToSign = `${encodedHeader}.${encodedPayload}`;
    const signature = crypto.createHmac("sha256", this.SECRET).update(dataToSign).digest("base64url");

    return `${dataToSign}.${signature}`;
  }

  /**
   * Xác thực token và giải mã payload
   */
  public static verify(token: string): { valid: boolean; payload?: JwtPayload; error?: string } {
    if (!token || typeof token !== "string") {
      return { valid: false, error: "Token không tồn tại hoặc sai định dạng." };
    }

    const parts = token.trim().split(".");
    if (parts.length !== 3) {
      return { valid: false, error: "Cấu trúc JWT không hợp lệ (Phải gồm 3 phần phân cách bởi dấu chấm)." };
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    const dataToSign = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = crypto.createHmac("sha256", this.SECRET).update(dataToSign).digest("base64url");

    // So sánh chữ ký an toàn chống Timing Attack
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, error: "Chữ ký Token không hợp lệ (Dữ liệu đã bị can thiệp trái phép)." };
    }

    try {
      const payloadJson = Buffer.from(encodedPayload, "base64url").toString("utf-8");
      const payload: JwtPayload = JSON.parse(payloadJson);

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        return { valid: false, error: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại." };
      }

      return { valid: true, payload };
    } catch {
      return { valid: false, error: "Payload Token bị hỏng hoặc không đúng chuẩn JSON." };
    }
  }
}
