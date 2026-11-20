/**
 * UserService - Quản lý tài khoản người dùng, băm mật khẩu, xác thực JWT,
 * Rate Limiting chống Brute-force và kiểm tra Chính sách mật khẩu mạnh.
 */

import { Pool } from "pg";
import crypto from "node:crypto";
import { JwtService } from "./jwt-service.js";

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  nodePort: number;
  createdAt: number;
}

export interface AuthResult {
  success: boolean;
  error?: string;
  user?: UserRecord;
  token?: string;
  remainingAttempts?: number;
  lockedMinutes?: number;
}

export class UserService {
  constructor(private pool: Pool) {}

  public static hashPassword(password: string, salt: string): string {
    return crypto.scryptSync(password, salt, 64).toString("hex");
  }

  /**
   * Kiểm tra chính sách mật khẩu mạnh:
   * - Tối thiểu 8 ký tự
   * - Ít nhất 1 chữ hoa (A-Z)
   * - Ít nhất 1 chữ thường (a-z)
   * - Ít nhất 1 chữ số (0-9)
   * - Ít nhất 1 ký tự đặc biệt (!@#$%^&*...)
   */
  public static validatePasswordPolicy(password: string): { valid: boolean; error?: string } {
    if (!password || password.length < 8) {
      return { valid: false, error: "Mật khẩu phải có tối thiểu 8 ký tự." };
    }
    if (!/[A-Z]/.test(password)) {
      return { valid: false, error: "Mật khẩu phải chứa ít nhất 1 chữ cái in hoa (A-Z)." };
    }
    if (!/[a-z]/.test(password)) {
      return { valid: false, error: "Mật khẩu phải chứa ít nhất 1 chữ cái in thường (a-z)." };
    }
    if (!/[0-9]/.test(password)) {
      return { valid: false, error: "Mật khẩu phải chứa ít nhất 1 chữ số (0-9)." };
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
      return { valid: false, error: "Mật khẩu phải chứa ít nhất 1 ký tự đặc biệt (!@#$%^&*...)." };
    }
    return { valid: true };
  }

  /**
   * Đăng ký tài khoản mới kèm thẩm định chính sách mật khẩu mạnh
   */
  public async register(
    username: string,
    password: string,
    displayName: string,
    nodePort?: number
  ): Promise<AuthResult> {
    const cleanUsername = (username || "").trim().toLowerCase();
    if (!cleanUsername || cleanUsername.length < 3) {
      return { success: false, error: "Tên đăng nhập phải có ít nhất 3 ký tự (chỉ gồm chữ và số)." };
    }

    // 1. Thẩm định chính sách mật khẩu mạnh
    const passwordCheck = UserService.validatePasswordPolicy(password);
    if (!passwordCheck.valid) {
      return { success: false, error: passwordCheck.error };
    }

    const cleanDisplay = (displayName || "").trim() || cleanUsername;

    try {
      // 2. Kiểm tra tên đăng nhập đã tồn tại chưa
      const existing = await this.pool.query("SELECT id FROM users WHERE username = $1", [cleanUsername]);
      if (existing.rows.length > 0) {
        return { success: false, error: "Tên đăng nhập đã tồn tại, vui lòng chọn tên khác." };
      }

      // 3. Tự động phân bổ xoay vòng vào 4 Node P2P đang chạy (3001, 3002, 3003, 3004)
      const AVAILABLE_PORTS = [3001, 3002, 3003, 3004];
      let assignedPort = nodePort;
      if (!assignedPort || !AVAILABLE_PORTS.includes(assignedPort)) {
        const countRes = await this.pool.query("SELECT COUNT(*) as total FROM users");
        const total = Number(countRes.rows[0]?.total || 0);
        assignedPort = AVAILABLE_PORTS[total % AVAILABLE_PORTS.length];
      }

      const salt = crypto.randomBytes(16).toString("hex");
      const passwordHash = UserService.hashPassword(password, salt);
      const userId = crypto.randomUUID();
      const now = Date.now();

      await this.pool.query(
        `INSERT INTO users (id, username, password_hash, password_salt, display_name, node_port, created_at, failed_attempts, last_failed_at, locked_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0)`,
        [userId, cleanUsername, passwordHash, salt, cleanDisplay, assignedPort, now]
      );

      const userRecord: UserRecord = {
        id: userId,
        username: cleanUsername,
        displayName: cleanDisplay,
        nodePort: assignedPort,
        createdAt: now
      };

      // 4. Cấp JWT Token có chữ ký số (Thời hạn 30 phút = 1800 giây)
      const token = JwtService.sign(
        {
          userId,
          username: cleanUsername,
          displayName: cleanDisplay,
          nodePort: assignedPort
        },
        1800
      );

      return {
        success: true,
        user: userRecord,
        token
      };
    } catch (err: any) {
      return { success: false, error: `Lỗi đăng ký tài khoản: ${err.message}` };
    }
  }

  /**
   * Xác thực đăng nhập có kiểm soát Rate Limiting & Account Lockout chống Brute-force
   */
  public async login(username: string, password: string): Promise<AuthResult> {
    const cleanUsername = (username || "").trim().toLowerCase();
    if (!cleanUsername || !password) {
      return { success: false, error: "Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu." };
    }

    try {
      const res = await this.pool.query(
        `SELECT id, username, password_hash, password_salt, display_name, node_port, created_at,
                COALESCE(failed_attempts, 0) as failed_attempts,
                COALESCE(last_failed_at, 0) as last_failed_at,
                COALESCE(locked_until, 0) as locked_until
         FROM users WHERE username = $1`,
        [cleanUsername]
      );

      if (res.rows.length === 0) {
        return { success: false, error: "Tài khoản hoặc mật khẩu không chính xác." };
      }

      const row = res.rows[0];
      const now = Date.now();
      const lockedUntil = Number(row.locked_until || 0);

      // 1. KIỂM TRA TÀI KHOẢN CÓ ĐANG BỊ KHÓA KHÔNG (Account Lockout)
      if (lockedUntil > now) {
        const remainingMinutes = Math.ceil((lockedUntil - now) / 60000);
        return {
          success: false,
          error: `⚠️ Tài khoản đang bị khóa do nhập sai mật khẩu quá 5 lần liên tiếp. Vui lòng thử lại sau ${remainingMinutes} phút.`,
          lockedMinutes: remainingMinutes
        };
      }

      // 2. KIỂM TRA MẬT KHẨU
      const computedHash = UserService.hashPassword(password, row.password_salt);
      const isPasswordCorrect = computedHash === row.password_hash;

      if (!isPasswordCorrect) {
        // XỬ LÝ NHẬP SAI MẬT KHẨU (Rate Limiting trong cửa sổ 5 phút)
        const lastFailedAt = Number(row.last_failed_at || 0);
        const windowTimeMs = 5 * 60 * 1000; // 5 phút

        let newAttempts = 1;
        if (now - lastFailedAt <= windowTimeMs) {
          newAttempts = Number(row.failed_attempts || 0) + 1;
        }

        if (newAttempts >= 5) {
          // Khóa tài khoản trong 15 phút
          const lockTime = now + 15 * 60 * 1000;
          await this.pool.query(
            "UPDATE users SET failed_attempts = $1, last_failed_at = $2, locked_until = $3 WHERE id = $4",
            [newAttempts, now, lockTime, row.id]
          );
          return {
            success: false,
            error: "🚫 BẠN ĐÃ NHẬP SAI 5 LẦN LIÊN TIẾP! Tài khoản đã bị tạm khóa 15 phút để bảo vệ chống tấn công dò mật khẩu (Brute-force).",
            lockedMinutes: 15,
            remainingAttempts: 0
          };
        } else {
          // Cập nhật số lần thử thất bại
          await this.pool.query(
            "UPDATE users SET failed_attempts = $1, last_failed_at = $2 WHERE id = $3",
            [newAttempts, now, row.id]
          );
          const remaining = 5 - newAttempts;
          return {
            success: false,
            error: `Tài khoản hoặc mật khẩu không chính xác. Bạn còn ${remaining} lần thử trước khi tài khoản bị khóa 15 phút.`,
            remainingAttempts: remaining
          };
        }
      }

      // 3. ĐĂNG NHẬP THÀNH CÔNG: Reset bộ đếm số lần sai
      if (row.failed_attempts > 0 || row.locked_until > 0) {
        await this.pool.query(
          "UPDATE users SET failed_attempts = 0, last_failed_at = 0, locked_until = 0 WHERE id = $4",
          [0, 0, 0, row.id]
        );
      }

      const userRecord: UserRecord = {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        nodePort: row.node_port,
        createdAt: Number(row.created_at)
      };

      // 4. CẤP TOKEN JWT ĐƯỢC KÝ SỐ HMAC-SHA256 (Thời hạn 30 phút = 1800 giây)
      const token = JwtService.sign(
        {
          userId: row.id,
          username: row.username,
          displayName: row.display_name,
          nodePort: row.node_port
        },
        1800
      );

      return {
        success: true,
        user: userRecord,
        token
      };
    } catch (err: any) {
      return { success: false, error: `Lỗi đăng nhập: ${err.message}` };
    }
  }

  /**
   * Xác thực JWT Token người dùng
   */
  public verifyToken(token: string): { valid: boolean; user?: UserRecord; error?: string } {
    const result = JwtService.verify(token);
    if (!result.valid || !result.payload) {
      return { valid: false, error: result.error };
    }
    return {
      valid: true,
      user: {
        id: result.payload.userId,
        username: result.payload.username,
        displayName: result.payload.displayName,
        nodePort: result.payload.nodePort,
        createdAt: (result.payload.iat || Math.floor(Date.now() / 1000)) * 1000
      }
    };
  }

  /**
   * Lấy danh sách tài khoản hiện có
   */
  public async listUsers(): Promise<UserRecord[]> {
    try {
      const res = await this.pool.query(
        "SELECT id, username, display_name, node_port, created_at FROM users ORDER BY created_at ASC"
      );
      return res.rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        nodePort: r.node_port,
        createdAt: Number(r.created_at)
      }));
    } catch (err) {
      return [];
    }
  }
}
