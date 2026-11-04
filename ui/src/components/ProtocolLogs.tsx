import React, { useState, useMemo } from "react";
import { ProtocolLogEntry, PeerInfo } from "../types";
import {
  Terminal,
  ChevronRight,
  ChevronLeft,
  ArrowDownLeft,
  ArrowUpRight,
  Cpu,
  EyeOff,
  Eye,
  Check,
  Copy,
  Activity,
  Layers,
  KeyRound,
  ShieldCheck,
  ShieldAlert
} from "lucide-react";

interface ProtocolLogsProps {
  logs: ProtocolLogEntry[];
  isOpen: boolean;
  onToggle: () => void;
  me?: string;
  tcpPort?: number;
  activePeer?: string | null;
  activePeerInfo?: PeerInfo;
  channelStatus?: string;
}

type LogCategoryFilter = "ALL" | "CHAT" | "FILE" | "SECURITY" | "SYSTEM";

export const ProtocolLogs: React.FC<ProtocolLogsProps> = ({
  logs,
  isOpen,
  onToggle,
  me,
  tcpPort,
  activePeer,
  activePeerInfo,
  channelStatus = "Plaintext",
}) => {
  const [selectedLog, setSelectedLog] = useState<ProtocolLogEntry | null>(null);
  const [hideHeartbeats, setHideHeartbeats] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<LogCategoryFilter>("ALL");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const isEncrypted =
    !channelStatus.toLowerCase().includes("plaintext") &&
    !channelStatus.toLowerCase().includes("chưa mã hóa");

  // Nhận diện heartbeat
  const isHeartbeatLog = (log: ProtocolLogEntry): boolean => {
    const type = (log.messageType || "").toUpperCase();
    const sum = (log.summary || "").toUpperCase();
    const cat = (log.category || "").toUpperCase();
    return type.includes("HEARTBEAT") || sum.includes("HEARTBEAT") || cat.includes("HEARTBEAT");
  };

  // Thống kê số lượng bản tin heartbeat
  const heartbeatCount = useMemo(() => {
    return logs.filter(isHeartbeatLog).length;
  }, [logs]);

  // Lọc danh sách log
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // 1. Lọc Heartbeat
      if (hideHeartbeats && isHeartbeatLog(log)) {
        return false;
      }

      // 2. Lọc theo Danh mục
      if (categoryFilter !== "ALL") {
        const type = (log.messageType || "").toUpperCase();
        const cat = (log.category || "").toUpperCase();
        const sum = (log.summary || "").toUpperCase();

        if (categoryFilter === "CHAT") {
          const isChatOrAck =
            type.includes("CHAT") ||
            cat.includes("CHAT") ||
            sum.includes("CHAT") ||
            type.includes("ACK") ||
            cat.includes("ACK") ||
            sum.includes("ACK");
          if (!isChatOrAck) return false;
        } else if (categoryFilter === "FILE") {
          if (!type.includes("FILE") && !cat.includes("FILE") && !sum.includes("FILE")) return false;
        } else if (categoryFilter === "SECURITY") {
          const isSec =
            type.includes("HANDSHAKE") ||
            type.includes("AUTH") ||
            type.includes("KEY") ||
            type.includes("TICKET") ||
            type.includes("KDC") ||
            cat.includes("SEC") ||
            sum.includes("MÃ HÓA") ||
            sum.includes("ENCRYPT") ||
            sum.includes("KDC") ||
            sum.includes("KERBEROS");
          if (!isSec) return false;
        } else if (categoryFilter === "SYSTEM") {
          if (log.direction !== "INTERNAL" && !type.includes("SYS") && !cat.includes("SYS")) return false;
        }
      }

      return true;
    });
  }, [logs, hideHeartbeats, categoryFilter]);

  const handleCopyPayload = (id: string, details: any, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(JSON.stringify(details, null, 2));
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  /**
   * Phân biệt màu sắc rõ ràng theo yêu cầu:
   * - Heartbeat: màu xám nhạt
   * - Chat / ACK: màu xanh lá / xanh dương
   * - Bảo mật / KDC: màu cam / tím
   * - File: màu chàm
   * - Lỗi: màu đỏ hồng
   */
  const getMessageTypeBadge = (type?: string, summary?: string) => {
    if (!type) return null;
    const t = type.toUpperCase();
    const s = (summary || "").toUpperCase();

    // 1. Heartbeat: màu xám nhạt
    if (t.includes("HEARTBEAT") || s.includes("HEARTBEAT")) {
      return (
        <span className="bg-slate-100 text-slate-500 border border-slate-200 px-1.5 py-0.5 rounded text-[11px] font-mono font-medium">
          {type}
        </span>
      );
    }

    // 2. ACK: màu xanh lá
    if (t.includes("ACK") || s.includes("ACK")) {
      return (
        <span className="bg-emerald-50 text-emerald-800 border border-emerald-300 px-1.5 py-0.5 rounded text-[11px] font-mono font-bold">
          {type}
        </span>
      );
    }

    // 3. Chat: màu xanh dương
    if (t.includes("CHAT") || s.includes("CHAT")) {
      return (
        <span className="bg-sky-50 text-sky-800 border border-sky-300 px-1.5 py-0.5 rounded text-[11px] font-mono font-bold">
          {type}
        </span>
      );
    }

    // 4. KDC / Ticket / Key: màu tím
    if (t.includes("KDC") || t.includes("TICKET") || t.includes("KEY") || s.includes("KDC") || s.includes("TICKET")) {
      return (
        <span className="bg-purple-50 text-purple-900 border border-purple-300 px-1.5 py-0.5 rounded text-[11px] font-mono font-bold">
          {type}
        </span>
      );
    }

    // 5. Bảo mật / Auth / Handshake: màu cam
    if (t.includes("HANDSHAKE") || t.includes("AUTH") || s.includes("AUTH") || s.includes("HANDSHAKE")) {
      return (
        <span className="bg-amber-50 text-amber-900 border border-amber-300 px-1.5 py-0.5 rounded text-[11px] font-mono font-bold">
          {type}
        </span>
      );
    }

    // 6. File Transfer: màu chàm / indigo
    if (t.includes("FILE") || s.includes("CHUNK") || s.includes("FILE")) {
      return (
        <span className="bg-indigo-50 text-indigo-900 border border-indigo-200 px-1.5 py-0.5 rounded text-[11px] font-mono font-bold">
          {type}
        </span>
      );
    }

    // 7. Lỗi / Thất bại: màu đỏ hồng
    if (t.includes("ERROR") || t.includes("FAIL") || s.includes("LỖI") || s.includes("FAIL")) {
      return (
        <span className="bg-rose-50 text-rose-800 border border-rose-300 px-1.5 py-0.5 rounded text-[11px] font-mono font-bold">
          {type}
        </span>
      );
    }

    // Mặc định hệ thống
    return (
      <span className="bg-slate-100 text-slate-700 border border-slate-300 px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold">
        {type}
      </span>
    );
  };

  return (
    <aside
      className={`border-l border-slate-200 bg-white flex flex-col transition-all duration-150 ease-in-out select-none ${
        isOpen ? "w-[380px] lg:w-[420px] xl:w-[460px]" : "w-11"
      }`}
    >
      {/* Header bar - Cân đối đồng bộ với ChatArea (h-13 min-h-[3.25rem]) */}
      <div className="h-13 min-h-[3.25rem] border-b border-slate-200 px-2.5 flex items-center justify-between bg-slate-50">
        <button
          onClick={onToggle}
          className="p-1 hover:bg-white rounded-md text-slate-500 hover:text-slate-900 border border-slate-300 bg-white transition-all flex items-center justify-center"
          title={isOpen ? "Thu gọn Inspector" : "Mở rộng bảng TCP Inspector"}
        >
          {isOpen ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>

        {isOpen && (
          <div className="flex-1 flex items-center justify-between pl-2.5 pr-1">
            <div className="flex items-center space-x-2 text-xs font-mono font-bold text-slate-900 uppercase tracking-wider">
              <Terminal className="w-3.5 h-3.5 text-slate-600" />
              <span>TCP Inspector</span>
            </div>

            <div className="flex items-center space-x-1.5">
              <span className="text-slate-500 text-[11px] font-mono bg-slate-200/60 px-1.5 py-0.5 rounded">
                {filteredLogs.length}/{logs.length} pkts
              </span>
            </div>
          </div>
        )}
      </div>

      {isOpen && (
        <div className="flex-1 flex flex-col min-h-0 bg-white">
          {/* Thông số kỹ thuật phiên: SESSION SPECS - Bảng Postman / VS Code */}
          <div className="p-3 border-b border-slate-200 bg-slate-50/60">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600 font-mono flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-slate-500" />
                SESSION SPECS
              </span>
              <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse" />
            </div>

            <div className="bg-white border border-slate-200 rounded-md p-2.5 font-mono text-[12px] space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Local Node</span>
                <span className="text-slate-900 font-bold">
                  {me || "peer"}:{tcpPort || "---"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Remote Peer</span>
                <span className="text-slate-900 font-bold">
                  {activePeerInfo
                    ? `${activePeerInfo.ip}:${activePeerInfo.tcpPort}`
                    : activePeer
                    ? `${activePeer}:8002`
                    : "IDLE"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Encryption</span>
                <span className={`font-bold ${isEncrypted ? "text-emerald-700" : "text-amber-700"}`}>
                  {isEncrypted ? "AES-256 (E2E)" : "PLAINTEXT (STAGE 1)"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Auth / KDC</span>
                <span className="text-slate-800 font-semibold">
                  {isEncrypted ? "KERBEROS TICKET (OK)" : "UNVERIFIED"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Transport</span>
                <span className="text-slate-800 font-medium">DIRECT TCP • MTU 64KB</span>
              </div>
            </div>
          </div>

          {/* Thanh công cụ lọc gói tin (Filter Toolbar) */}
          <div className="p-2.5 border-b border-slate-200 bg-slate-50/40 space-y-2">
            {/* Hàng 1: Nút bật/tắt Ẩn Heartbeat */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => setHideHeartbeats(!hideHeartbeats)}
                className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-xs font-mono font-medium border transition-all ${
                  hideHeartbeats
                    ? "bg-sky-50 text-sky-800 border-sky-300"
                    : "bg-white text-slate-600 border-slate-300 hover:bg-slate-100"
                }`}
                title="Bật/Tắt ẩn các gói tin Heartbeat để không làm trôi log"
              >
                {hideHeartbeats ? (
                  <EyeOff className="w-3.5 h-3.5 text-sky-600" />
                ) : (
                  <Eye className="w-3.5 h-3.5 text-slate-400" />
                )}
                <span>Ẩn Heartbeat</span>
                <span className="bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded text-[10px] ml-1">
                  {heartbeatCount}
                </span>
              </button>

              <span className="text-[11px] text-slate-500 font-mono">
                Buffer: {logs.length}
              </span>
            </div>

            {/* Hàng 2: Bộ lọc theo loại bản tin */}
            <div className="flex items-center gap-1 overflow-x-auto pb-0.5 text-xs font-mono">
              {(
                [
                  { id: "ALL", label: "Tất cả" },
                  { id: "CHAT", label: "Chat/ACK" },
                  { id: "FILE", label: "File" },
                  { id: "SECURITY", label: "Bảo mật/KDC" },
                  { id: "SYSTEM", label: "Hệ thống" },
                ] as const
              ).map((tab) => {
                const isActive = categoryFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setCategoryFilter(tab.id)}
                    className={`px-2 py-1 rounded-md text-[11px] transition-all whitespace-nowrap ${
                      isActive
                        ? "bg-slate-900 text-white font-bold"
                        : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Danh sách các log cuộn độc lập */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100 font-mono">
            {filteredLogs.length === 0 ? (
              <div className="p-8 text-center text-slate-400 space-y-1.5">
                <Activity className="w-6 h-6 text-slate-300 mx-auto stroke-1" />
                <p className="text-xs font-mono uppercase font-bold text-slate-600">
                  Không có gói tin nào
                </p>
                {hideHeartbeats && heartbeatCount > 0 && (
                  <p className="text-[11px] text-slate-400 font-sans">
                    Đang ẩn {heartbeatCount} gói tin Heartbeat. Bấm vào "Ẩn Heartbeat" để xem lại.
                  </p>
                )}
              </div>
            ) : (
              filteredLogs.map((log) => {
                const isSelected = selectedLog?.id === log.id;
                const isHeartbeat = isHeartbeatLog(log);

                return (
                  <div
                    key={log.id}
                    onClick={() => setSelectedLog(isSelected ? null : log)}
                    className={`p-2.5 cursor-pointer transition-colors border-l-2 ${
                      isSelected
                        ? "bg-sky-50/70 border-sky-600"
                        : isHeartbeat
                        ? "opacity-50 hover:opacity-100 hover:bg-slate-50 border-transparent"
                        : "hover:bg-slate-50/90 border-transparent"
                    }`}
                  >
                    {/* Hàng 1: Thời gian & Badges */}
                    <div className="flex items-center justify-between text-slate-500 mb-1 flex-wrap gap-1">
                      <span className="text-[11px] font-mono text-slate-500">
                        {log.timeStr.substring(11, 19)}
                      </span>

                      <div className="flex items-center space-x-1">
                        {log.direction === "IN" && (
                          <span className="flex items-center text-emerald-800 bg-emerald-50 border border-emerald-300 px-1 py-0.2 rounded text-[10px] font-bold">
                            <ArrowDownLeft className="w-3 h-3 mr-0.5" /> IN
                          </span>
                        )}
                        {log.direction === "OUT" && (
                          <span className="flex items-center text-sky-800 bg-sky-50 border border-sky-300 px-1 py-0.2 rounded text-[10px] font-bold">
                            <ArrowUpRight className="w-3 h-3 mr-0.5" /> OUT
                          </span>
                        )}
                        {log.direction === "INTERNAL" && (
                          <span className="flex items-center text-slate-700 bg-slate-100 border border-slate-300 px-1 py-0.2 rounded text-[10px] font-semibold">
                            <Cpu className="w-3 h-3 mr-0.5" /> SYS
                          </span>
                        )}

                        {getMessageTypeBadge(log.messageType, log.summary)}
                      </div>
                    </div>

                    {/* Hàng 2: Tóm tắt thông điệp gói tin */}
                    <div className="text-[12px] text-slate-900 break-words font-medium leading-relaxed font-mono">
                      {log.summary}
                    </div>

                    {/* Hàng 3: Chi tiết Payload khi bấm vào dòng log (VS Code JSON Inspector style) */}
                    {isSelected && log.details && (
                      <div className="mt-2 p-2.5 bg-slate-950 text-slate-200 rounded-md text-[11px] font-mono border border-slate-800 shadow-inner select-text space-y-1.5">
                        <div className="flex items-center justify-between pb-1.5 border-b border-slate-800 text-[10px] text-slate-400">
                          <span className="font-semibold text-slate-300 uppercase tracking-wider">
                            TCP Payload Inspector
                          </span>
                          <button
                            onClick={(e) => handleCopyPayload(log.id, log.details, e)}
                            className="flex items-center space-x-1 hover:text-white px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 transition-colors"
                            title="Sao chép JSON"
                          >
                            {copiedId === log.id ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-400" />
                                <span className="text-emerald-400">Đã chép</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                <span>Copy JSON</span>
                              </>
                            )}
                          </button>
                        </div>
                        <pre className="overflow-x-auto text-[11px] text-emerald-400 leading-snug py-1">
                          {JSON.stringify(log.details, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </aside>
  );
};
