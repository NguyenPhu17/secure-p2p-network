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
  ShieldAlert,
  CheckCircle2,
  XCircle,
  KeyRound,
  Eye,
  EyeOff
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
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  // Form Đăng ký
  const [regUsername, setRegUsername] = useState("");
  const [regDisplayName, setRegDisplayName] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirmPassword, setRegConfirmPassword] = useState("");
  const [showRegPassword, setShowRegPassword] = useState(false);

  // Kiểm tra độ mạnh mật khẩu thời gian thực
  const passCheck = checkPasswordStrength(regPassword);

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

  // Xử lý Đăng ký
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Kiểm tra chính sách mật khẩu mạnh
    if (!passCheck.isValid) {
      setError("Mật khẩu chưa đáp ứng đầy đủ tiêu chuẩn bảo mật (Xem danh sách bên dưới).");
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
        undefined, // CSDL tự động gán Peer Node thông minh xoay vòng
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
                <span>Secure P2P Chat</span>
                <span className="bg-[#E0F2FE] text-[#0369A1] text-[10px] px-1.5 py-0.5 rounded-[4px] font-mono">
                  Online
                </span>
              </h2>
              <p className="text-xs text-[#64748B]">Mạng Ngang Hàng Phân Tán • Bảo Mật Token JWT</p>
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
            <span>ĐĂNG KÝ MỚI</span>
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
                  placeholder="Nhập tên tài khoản..."
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
                  type={showLoginPassword ? "text" : "password"}
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] pl-8 pr-10 py-2 text-sm text-[#0F172A] focus:outline-none focus:border-[#0F172A] focus:bg-white transition-colors"
                />
                <Lock className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-3" />
                <button
                  type="button"
                  onClick={() => setShowLoginPassword(!showLoginPassword)}
                  className="absolute right-2.5 top-2.5 text-[#94A3B8] hover:text-[#0F172A] transition-colors p-0.5 focus:outline-none"
                  title={showLoginPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                >
                  {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#0F172A] hover:bg-[#1E293B] disabled:bg-[#94A3B8] text-white font-mono font-medium py-2.5 px-4 rounded-[6px] text-xs transition-colors flex items-center justify-center space-x-2"
            >
              <span>{loading ? "ĐANG ĐĂNG NHẬP..." : "ĐĂNG NHẬP"}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>
        )}

        {/* TAB 2: FORM ĐĂNG KÝ */}
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
                  onChange={(e) => setRegUsername(e.target.value.toLowerCase().replace(/\s+/g, ""))}
                  placeholder="vd: minh, phu, tuan..."
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
                placeholder="vd: Minh Trần, Phú Nguyễn..."
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
                    type={showRegPassword ? "text" : "password"}
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="Mật khẩu mạnh"
                    required
                    className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] pl-8 pr-10 py-2 text-sm text-[#0F172A] focus:outline-none focus:border-[#0F172A] focus:bg-white transition-colors"
                  />
                  <Lock className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-3" />
                  <button
                    type="button"
                    onClick={() => setShowRegPassword(!showRegPassword)}
                    className="absolute right-2.5 top-2.5 text-[#94A3B8] hover:text-[#0F172A] transition-colors p-0.5 focus:outline-none"
                    title={showRegPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  >
                    {showRegPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-mono font-semibold uppercase tracking-wider text-[#0F172A] mb-1">
                  Xác nhận MK
                </label>
                <div className="relative">
                  <input
                    type={showRegPassword ? "text" : "password"}
                    value={regConfirmPassword}
                    onChange={(e) => setRegConfirmPassword(e.target.value)}
                    placeholder="Nhập lại mật khẩu"
                    required
                    className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] pl-8 pr-3 py-2 text-sm text-[#0F172A] focus:outline-none focus:border-[#0F172A] focus:bg-white transition-colors"
                  />
                  <Lock className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-3" />
                </div>
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
                  Ít nhất 1 chữ hoa (A-Z)
                </span>
                <span className={`flex items-center gap-1 ${passCheck.hasNumber ? "text-[#10B981] font-semibold" : "text-[#94A3B8]"}`}>
                  {passCheck.hasNumber ? <CheckCircle2 className="w-3 h-3 text-[#10B981]" /> : <XCircle className="w-3 h-3" />}
                  Ít nhất 1 chữ số (0-9)
                </span>
                <span className={`flex items-center gap-1 ${passCheck.hasSpecial ? "text-[#10B981] font-semibold" : "text-[#94A3B8]"}`}>
                  {passCheck.hasSpecial ? <CheckCircle2 className="w-3 h-3 text-[#10B981]" /> : <XCircle className="w-3 h-3" />}
                  1 ký tự đặc biệt (@#$...)
                </span>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !passCheck.isValid}
              className="w-full bg-[#0F172A] hover:bg-[#1E293B] disabled:bg-[#94A3B8] text-white font-mono font-medium py-2.5 px-4 rounded-[6px] text-xs transition-colors flex items-center justify-center space-x-2"
            >
              <span>{loading ? "ĐANG TẠO TÀI KHOẢN..." : "ĐĂNG KÝ TÀI KHOẢN MỚI"}</span>
              <UserPlus className="w-3.5 h-3.5" />
            </button>
          </form>
        )}

        {/* Footer thông tin P2P */}
        <div className="pt-2 border-t border-[#E2E8F0]">
          <div className="flex items-center justify-between text-[11px] font-mono text-[#94A3B8] pt-1">
            <span className="flex items-center gap-1">
              <Server className="w-3 h-3" />
              Direct TCP Mesh
            </span>
            <span className="flex items-center gap-1">
              <Layers className="w-3 h-3" />
              Tự động phân bổ Peer Node
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
