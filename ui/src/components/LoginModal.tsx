import React, { useState } from "react";
import {
  Terminal,
  ArrowRight,
  User,
  Lock,
  UserPlus,
  LogIn,
  AlertCircle,
  Server,
  Layers,
  Sparkles,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  KeyRound
} from "lucide-react";
import { apiLogin, apiRegister, AuthUser, checkPasswordStrength } from "../utils/authApi";

interface LoginModalProps {
  onLoginSuccess: (user: AuthUser, token?: string) => void;
  defaultPort?: number;
}

export const LoginModal: React.FC<LoginModalProps> = ({ onLoginSuccess, defaultPort = 3001 }) => {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedMinutes, setLockedMinutes] = useState<number | null>(null);

  // Form Đăng nhập
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  // Form Đăng ký
  const [regUsername, setRegUsername] = useState("");
  const [regDisplayName, setRegDisplayName] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirmPassword, setRegConfirmPassword] = useState("");

  // Kiểm tra độ mạnh mật khẩu thời gian thực
  const passCheck = checkPasswordStrength(regPassword);

  // Chế độ nâng cao kết nối thẳng qua Port
  const [showDirectPort, setShowDirectPort] = useState(false);
  const [directPort, setDirectPort] = useState(defaultPort.toString());

  // Xử lý Đăng nhập
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLockedMinutes(null);
    setLoading(true);

    try {
      const res = await apiLogin(loginUsername, loginPassword, defaultPort);
      if (res.success && res.user) {
        onLoginSuccess(res.user, res.token);
      } else {
        setError(res.error || "Tài khoản hoặc mật khẩu không chính xác.");
        if (res.lockedMinutes) {
          setLockedMinutes(res.lockedMinutes);
        }
      }
    } catch (err: any) {
      setError(err.message || "Lỗi kết nối tới hệ thống.");
    } finally {
      setLoading(false);
    }
  };

  // Đăng nhập nhanh bằng tài khoản mẫu
  const handleQuickLogin = async (username: string, port: number) => {
    setLoginUsername(username);
    setLoginPassword("123456");
    setError(null);
    setLockedMinutes(null);
    setLoading(true);

    try {
      const res = await apiLogin(username, "123456", port);
      if (res.success && res.user) {
        onLoginSuccess(res.user, res.token);
      } else {
        setError(res.error || `Không thể đăng nhập tài khoản ${username}`);
        if (res.lockedMinutes) {
          setLockedMinutes(res.lockedMinutes);
        }
      }
    } catch (err: any) {
      setError(err.message || "Lỗi kết nối.");
    } finally {
      setLoading(false);
    }
  };

  // Xử lý Đăng ký
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Kiểm tra chính sách mật khẩu mạnh
    if (!passCheck.isValid) {
      setError("Mật khẩu chưa đáp ứng đầy đủ chính sách mật khẩu mạnh bảo mật (Xem danh sách bên dưới).");
      return;
    }

    if (regPassword !== regConfirmPassword) {
      setError("Mật khẩu xác nhận không khớp.");
      return;
    }

    setLoading(true);
    try {
      const res = await apiRegister(
        regUsername,
        regPassword,
        regDisplayName || regUsername,
        undefined, // CSDL tự động gán cổng kế tiếp
        defaultPort
      );
      if (res.success && res.user) {
        onLoginSuccess(res.user, res.token);
      } else {
        setError(res.error || "Đăng ký không thành công.");
      }
    } catch (err: any) {
      setError(err.message || "Lỗi kết nối tới hệ thống.");
    } finally {
      setLoading(false);
    }
  };

  // Kết nối trực tiếp qua Port (Chế độ tương thích cũ)
  const handleDirectPortConnect = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseInt(directPort, 10);
    if (!isNaN(p) && p > 0) {
      onLoginSuccess({
        id: `legacy_${p}`,
        username: `peer_${p}`,
        displayName: `Peer (${p})`,
        nodePort: p,
        createdAt: Date.now()
      });
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col items-center justify-center p-6 select-none font-sans">
      <div className="bg-white border border-[#E2E8F0] shadow-sm rounded-[10px] max-w-md w-full p-6 space-y-5">
        {/* Header Logo & Title */}
        <div className="space-y-1.5 pb-3 border-b border-[#E2E8F0]">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-[6px] bg-[#0F172A] text-white flex items-center justify-center shadow-sm">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-[15px] font-bold text-[#0F172A] font-mono tracking-tight uppercase flex items-center gap-1.5">
                <span>P2P Secure Network</span>
                <span className="bg-[#E0F2FE] text-[#0369A1] text-[10px] px-1.5 py-0.5 rounded-[4px] font-mono">
                  JWT & Lockout
                </span>
              </h2>
              <p className="text-xs text-[#64748B]">Hệ thống Chat Phân tán Zero SPOF & Định tuyến Mesh</p>
            </div>
          </div>
        </div>

        {/* Tab Switcher: Đăng nhập / Đăng ký */}
        <div className="flex bg-[#F1F5F9] p-1 rounded-[6px] border border-[#E2E8F0]">
          <button
            type="button"
            onClick={() => {
              setTab("login");
              setError(null);
            }}
            className={`flex-1 py-1.5 text-xs font-mono font-semibold rounded-[4px] transition-all flex items-center justify-center space-x-1.5 ${
              tab === "login"
                ? "bg-white text-[#0F172A] shadow-xs"
                : "text-[#64748B] hover:text-[#0F172A]"
            }`}
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>ĐĂNG NHẬP</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setTab("register");
              setError(null);
            }}
            className={`flex-1 py-1.5 text-xs font-mono font-semibold rounded-[4px] transition-all flex items-center justify-center space-x-1.5 ${
              tab === "register"
                ? "bg-white text-[#0F172A] shadow-xs"
                : "text-[#64748B] hover:text-[#0F172A]"
            }`}
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>ĐĂNG KÝ </span>
          </button>
        </div>

        {/* Banner cảnh báo Khóa tài khoản (Account Lockout) */}
        {lockedMinutes && (
          <div className="bg-[#FEF2F2] border-2 border-[#EF4444] text-[#991B1B] p-3 rounded-[8px] text-xs flex items-start space-x-2.5 shadow-xs animate-pulse">
            <ShieldAlert className="w-5 h-5 text-[#DC2626] flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-bold text-[13px] uppercase tracking-wide">TÀI KHOẢN ĐÃ BỊ KHÓA</div>
              <p className="leading-snug">
                Phát hiện hành vi nhập sai mật khẩu 5 lần liên tiếp. Hệ thống đã kích hoạt khóa bảo vệ 15 phút chống tấn công Brute-force.
              </p>
            </div>
          </div>
        )}

        {/* Error Alert chung */}
        {error && !lockedMinutes && (
          <div className="bg-[#FEF2F2] border border-[#FCA5A5] text-[#991B1B] px-3 py-2 rounded-[6px] text-xs flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span className="leading-tight">{error}</span>
          </div>
        )}

        {/* TAB 1: FORM ĐĂNG NHẬP */}
        {tab === "login" && (
          <form onSubmit={handleLogin} className="space-y-3.5">
            <div>
              <label className="block text-[11px] font-mono font-semibold uppercase tracking-wider text-[#0F172A] mb-1">
                Tên đăng nhập
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  placeholder="alice, bob, charlie..."
                  required
                  className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] pl-8 pr-3 py-2 text-sm text-[#0F172A] focus:outline-none focus:border-[#0F172A] focus:bg-white transition-colors"
                />
                <User className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-3" />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-mono font-semibold uppercase tracking-wider text-[#0F172A] mb-1">
                Mật khẩu
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••"
                  required
                  className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] pl-8 pr-3 py-2 text-sm text-[#0F172A] focus:outline-none focus:border-[#0F172A] focus:bg-white transition-colors"
                />
                <Lock className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-3" />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#0F172A] hover:bg-[#1E293B] disabled:bg-[#94A3B8] text-white font-mono font-medium py-2.5 px-4 rounded-[6px] text-xs transition-colors flex items-center justify-center space-x-2"
            >
              <span>{loading ? "ĐANG XÁC THỰC JWT..." : "ĐĂNG NHẬP (CẤP TOKEN JWT)"}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>

            {/* Quick Login Chips cho Demo */}
            <div className="pt-2 border-t border-[#F1F5F9]">
              <div className="text-[11px] font-mono text-[#64748B] flex items-center gap-1 mb-1.5">
                <Sparkles className="w-3 h-3 text-[#EAB308]" />
                <span>Đăng nhập nhanh mẫu (Mật khẩu: 123456):</span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleQuickLogin("alice", 3001)}
                  className="flex-1 bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0F172A] border border-[#E2E8F0] rounded-[4px] py-1 text-xs font-mono font-medium transition-colors"
                >
                  Alice (:3001)
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickLogin("bob", 3002)}
                  className="flex-1 bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0F172A] border border-[#E2E8F0] rounded-[4px] py-1 text-xs font-mono font-medium transition-colors"
                >
                  Bob (:3002)
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickLogin("charlie", 3003)}
                  className="flex-1 bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0F172A] border border-[#E2E8F0] rounded-[4px] py-1 text-xs font-mono font-medium transition-colors"
                >
                  Charlie (:3003)
                </button>
              </div>
            </div>
          </form>
        )}

        {/* TAB 2: FORM ĐĂNG KÝ BẢO MẬT */}
        {tab === "register" && (
          <form onSubmit={handleRegister} className="space-y-3">
            <div>
              <label className="block text-[11px] font-mono font-semibold uppercase tracking-wider text-[#0F172A] mb-1">
                Tên đăng nhập (Username)
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={regUsername}
                  onChange={(e) => setRegUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                  placeholder="viết liền không dấu, vd: david"
                  required
                  className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] pl-8 pr-3 py-2 text-sm text-[#0F172A] focus:outline-none focus:border-[#0F172A] focus:bg-white transition-colors"
                />
                <User className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-3" />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-mono font-semibold uppercase tracking-wider text-[#0F172A] mb-1">
                Tên hiển thị (Display Name)
              </label>
              <input
                type="text"
                value={regDisplayName}
                onChange={(e) => setRegDisplayName(e.target.value)}
                placeholder="vd: David Nguyễn"
                required
                className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] px-3 py-2 text-sm text-[#0F172A] focus:outline-none focus:border-[#0F172A] focus:bg-white transition-colors"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-mono font-semibold uppercase tracking-wider text-[#0F172A] mb-1">
                  Mật khẩu
                </label>
                <div className="relative">
                  <input
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="Mật khẩu mạnh"
                    required
                    className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] pl-8 pr-3 py-2 text-sm text-[#0F172A] focus:outline-none focus:border-[#0F172A] focus:bg-white transition-colors"
                  />
                  <Lock className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-3" />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-mono font-semibold uppercase tracking-wider text-[#0F172A] mb-1">
                  Xác nhận MK
                </label>
                <input
                  type="password"
                  value={regConfirmPassword}
                  onChange={(e) => setRegConfirmPassword(e.target.value)}
                  placeholder="Nhập lại mật khẩu"
                  required
                  className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] px-3 py-2 text-sm text-[#0F172A] focus:outline-none focus:border-[#0F172A] focus:bg-white transition-colors"
                />
              </div>
            </div>

            {/* Checklist chính sách mật khẩu mạnh theo thời gian thực */}
            <div className="bg-[#F8FAFC] border border-[#E2E8F0] p-2.5 rounded-[6px] space-y-1.5 text-[11px] font-mono">
              <div className="text-[#64748B] font-semibold flex items-center gap-1 mb-1">
                <KeyRound className="w-3 h-3 text-[#0F172A]" />
                <span>Tiêu chuẩn Chính sách Mật khẩu mạnh:</span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <span className={`flex items-center gap-1 ${passCheck.minLength ? "text-[#10B981] font-semibold" : "text-[#94A3B8]"}`}>
                  {passCheck.minLength ? <CheckCircle2 className="w-3 h-3 text-[#10B981]" /> : <XCircle className="w-3 h-3" />}
                  Tối thiểu 8 ký tự
                </span>
                <span className={`flex items-center gap-1 ${passCheck.hasUpper ? "text-[#10B981] font-semibold" : "text-[#94A3B8]"}`}>
                  {passCheck.hasUpper ? <CheckCircle2 className="w-3 h-3 text-[#10B981]" /> : <XCircle className="w-3 h-3" />}
                  Có chữ in hoa (A-Z)
                </span>
                <span className={`flex items-center gap-1 ${passCheck.hasLower ? "text-[#10B981] font-semibold" : "text-[#94A3B8]"}`}>
                  {passCheck.hasLower ? <CheckCircle2 className="w-3 h-3 text-[#10B981]" /> : <XCircle className="w-3 h-3" />}
                  Có chữ in thường (a-z)
                </span>
                <span className={`flex items-center gap-1 ${passCheck.hasNumber ? "text-[#10B981] font-semibold" : "text-[#94A3B8]"}`}>
                  {passCheck.hasNumber ? <CheckCircle2 className="w-3 h-3 text-[#10B981]" /> : <XCircle className="w-3 h-3" />}
                  Có chữ số (0-9)
                </span>
                <span className={`flex items-center gap-1 col-span-2 ${passCheck.hasSpecial ? "text-[#10B981] font-semibold" : "text-[#94A3B8]"}`}>
                  {passCheck.hasSpecial ? <CheckCircle2 className="w-3 h-3 text-[#10B981]" /> : <XCircle className="w-3 h-3" />}
                  Có ký tự đặc biệt (!@#$%^&*...)
                </span>
              </div>
            </div>

            <div className="pt-1">
              <div className="text-[11px] font-mono text-[#64748B] flex items-center justify-between">
                <span>Nút mạng Peer:</span>
                <span className="text-[#10B981] font-semibold">Tự động gán cổng từ CSDL</span>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#0F172A] hover:bg-[#1E293B] disabled:bg-[#94A3B8] text-white font-mono font-medium py-2.5 px-4 rounded-[6px] text-xs transition-colors flex items-center justify-center space-x-2 mt-2"
            >
              <span>{loading ? "ĐANG TẠO TÀI KHOẢN & JWT..." : "TẠO TÀI KHOẢN & CẤP TOKEN"}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>
        )}

        {/* Footer Toggle Chế độ Port Chuyên gia */}
        <div className="pt-2 border-t border-[#E2E8F0] space-y-2">
          <button
            type="button"
            onClick={() => setShowDirectPort(!showDirectPort)}
            className="text-[11px] font-mono text-[#64748B] hover:text-[#0F172A] underline flex items-center gap-1"
          >
            <Server className="w-3 h-3" />
            <span>{showDirectPort ? "Ẩn tùy chọn nâng cao" : "Chế độ Chuyên gia: Kết nối trực tiếp Port"}</span>
          </button>

          {showDirectPort && (
            <form onSubmit={handleDirectPortConnect} className="pt-2 flex gap-2">
              <input
                type="number"
                value={directPort}
                onChange={(e) => setDirectPort(e.target.value)}
                placeholder="3001"
                className="w-24 bg-[#F8FAFC] border border-[#CBD5E1] rounded-[4px] px-2 py-1 text-xs font-mono text-[#0F172A]"
              />
              <button
                type="submit"
                className="bg-[#E2E8F0] hover:bg-[#CBD5E1] text-[#0F172A] px-3 py-1 text-xs font-mono rounded-[4px] transition-colors"
              >
                Vào qua Port
              </button>
            </form>
          )}

          <div className="flex items-center justify-between text-[11px] font-mono text-[#94A3B8] pt-1">
            <span className="flex items-center gap-1">
              <Server className="w-3 h-3" />
              Direct TCP Mesh
            </span>
            <span className="flex items-center gap-1">
              <Layers className="w-3 h-3" />
              PostgreSQL Multi-Tenant
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
