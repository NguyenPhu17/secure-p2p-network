/**
 * authApi - Gọi API REST xác thực (Đăng nhập, Đăng ký, Kiểm tra JWT Token)
 * Hỗ trợ JWT Token, chống Brute-force và thẩm định chính sách mật khẩu mạnh.
 */

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  nodePort: number;
  createdAt: number;
}

export interface AuthResponse {
  success: boolean;
  error?: string;
  user?: AuthUser;
  users?: AuthUser[];
  token?: string;
  remainingAttempts?: number;
  lockedMinutes?: number;
}

export interface PasswordRuleCheck {
  minLength: boolean;
  hasUpper: boolean;
  hasLower: boolean;
  hasNumber: boolean;
  hasSpecial: boolean;
  isValid: boolean;
}

/**
 * Kiểm tra các tiêu chuẩn của chính sách mật khẩu mạnh theo thời gian thực
 */
export function checkPasswordStrength(password: string): PasswordRuleCheck {
  const minLength = (password || "").length >= 8;
  const hasUpper = /[A-Z]/.test(password || "");
  const hasLower = /[a-z]/.test(password || "");
  const hasNumber = /[0-9]/.test(password || "");
  const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password || "");
  const isValid = minLength && hasUpper && hasLower && hasNumber && hasSpecial;

  return { minLength, hasUpper, hasLower, hasNumber, hasSpecial, isValid };
}

const CANDIDATE_PORTS = [3001, 3002, 3003, 3004, 3005];

/**
 * Gửi yêu cầu đăng nhập
 */
export async function apiLogin(username: string, password: string, currentPort?: number): Promise<AuthResponse> {
  const portsToTry = currentPort
    ? [currentPort, ...CANDIDATE_PORTS.filter((p) => p !== currentPort)]
    : CANDIDATE_PORTS;
  const host = typeof window !== "undefined" && window.location.hostname ? window.location.hostname : "localhost";

  let lastError = "Không thể kết nối tới Backend.";
  for (const port of portsToTry) {
    try {
      const res = await fetch(`http://${host}:${port}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      return data;
    } catch (err: any) {
      lastError = err.message || lastError;
    }
  }
  return { success: false, error: `Không thể kết nối tới máy chủ Backend: ${lastError}` };
}

/**
 * Gửi yêu cầu đăng ký tài khoản mới (Cổng Node P2P tự động gán từ Backend)
 */
export async function apiRegister(
  username: string,
  password: string,
  displayName: string,
  nodePort?: number,
  currentPort?: number
): Promise<AuthResponse> {
  const portsToTry = currentPort
    ? [currentPort, ...CANDIDATE_PORTS.filter((p) => p !== currentPort)]
    : CANDIDATE_PORTS;
  const host = typeof window !== "undefined" && window.location.hostname ? window.location.hostname : "localhost";

  let lastError = "Không thể kết nối tới Backend.";
  for (const port of portsToTry) {
    try {
      const res = await fetch(`http://${host}:${port}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, displayName, nodePort })
      });
      const data = await res.json();
      return data;
    } catch (err: any) {
      lastError = err.message || lastError;
    }
  }
  return { success: false, error: `Không thể kết nối tới máy chủ Backend: ${lastError}` };
}

/**
 * Kiểm tra tính hợp lệ và thời hạn của JWT Token
 */
export async function apiVerifyToken(token: string, currentPort?: number): Promise<{ valid: boolean; user?: AuthUser; error?: string }> {
  if (!token) return { valid: false, error: "Token rỗng" };
  const portsToTry = currentPort
    ? [currentPort, ...CANDIDATE_PORTS.filter((p) => p !== currentPort)]
    : CANDIDATE_PORTS;
  const host = typeof window !== "undefined" && window.location.hostname ? window.location.hostname : "localhost";

  for (const port of portsToTry) {
    try {
      const res = await fetch(`http://${host}:${port}/api/auth/verify`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = await res.json();
      return data;
    } catch {
      // Thử cổng tiếp theo
    }
  }
  return { valid: false, error: "Không thể kết nối để kiểm tra token" };
}
