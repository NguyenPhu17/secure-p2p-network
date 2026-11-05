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
  Activity
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

type LogCategoryFilter = "ALL" | "DHT" | "CHAT" | "FILE" | "SECURITY" | "SYSTEM";

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

  const isHeartbeatLog = (log: ProtocolLogEntry): boolean => {
    const type = (log.messageType || "").toUpperCase();
    const sum = (log.summary || "").toUpperCase();
    const cat = (log.category || "").toUpperCase();
    return type.includes("HEARTBEAT") || sum.includes("HEARTBEAT") || cat.includes("HEARTBEAT");
  };

  const heartbeatCount = useMemo(() => {
    return logs.filter(isHeartbeatLog).length;
  }, [logs]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (hideHeartbeats && isHeartbeatLog(log)) {
        return false;
      }

      if (categoryFilter !== "ALL") {
        const type = (log.messageType || "").toUpperCase();
        const cat = (log.category || "").toUpperCase();
        const sum = (log.summary || "").toUpperCase();

        if (categoryFilter === "DHT") {
          const isDht = type.includes("DHT") || cat.includes("DHT") || sum.includes("DHT");
          if (!isDht) return false;
        } else if (categoryFilter === "CHAT") {
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

  const getMessageTypeBadge = (type?: string, summary?: string) => {
    if (!type) return null;
    const t = type.toUpperCase();
    const s = (summary || "").toUpperCase();

    let tagColor = "text-[#64748B]";
    if (t.includes("ACK") || s.includes("ACK")) {
      tagColor = "text-[#10B981]";
    } else if (t.includes("DHT") || s.includes("DHT")) {
      tagColor = "text-[#0D9488]";
    } else if (t.includes("CHAT") || s.includes("CHAT")) {
      tagColor = "text-[#0284C7]";
    } else if (t.includes("KEY") || t.includes("TICKET") || t.includes("KDC") || t.includes("AUTH")) {
      tagColor = "text-[#D97706]";
    } else if (t.includes("ERROR") || t.includes("FAIL") || s.includes("FAIL") || s.includes("LỖI")) {
      tagColor = "text-[#E11D48]";
    }

    return (
      <span className={`border border-[#E2E8F0] bg-[#F8FAFC] px-1.5 py-0.5 rounded-[4px] text-[11px] font-mono font-medium ${tagColor}`}>
        {type}
      </span>
    );
  };

  const remoteAddr = activePeerInfo
    ? `${activePeerInfo.ip}:${activePeerInfo.tcpPort}`
    : activePeer
    ? `${activePeer}:8002`
    : "IDLE";

  return (
    <aside
      className={`border-l border-[#E2E8F0] bg-white flex flex-col transition-all duration-150 ease-in-out select-none flex-shrink-0 ${
        isOpen ? "w-[440px] xl:w-[460px]" : "w-10"
      }`}
    >
      {/* 1. Header Bar (64px) */}
      <div className="h-[64px] min-h-[64px] border-b border-[#E2E8F0] px-3.5 flex items-center justify-between bg-[#F8FAFC]">
        <button
          onClick={onToggle}
          className="p-1.5 hover:bg-white rounded-[4px] text-[#64748B] hover:text-[#0F172A] border border-[#E2E8F0] bg-[#FFFFFF] transition-all flex items-center justify-center"
          title={isOpen ? "Thu gọn Inspector" : "Mở rộng bảng TCP Inspector"}
        >
          {isOpen ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>

        {isOpen && (
          <div className="flex-1 flex items-center justify-between pl-3 pr-1">
            <div className="flex items-center space-x-2 text-[13px] font-mono font-bold text-[#0F172A] uppercase tracking-wider">
              <Terminal className="w-4 h-4 text-[#64748B]" />
              <span>TCP Inspector</span>
            </div>

            <span className="text-[#64748B] text-[11.5px] font-mono bg-[#E2E8F0] px-2 py-0.5 rounded-[4px]">
              {filteredLogs.length}/{logs.length} pkts
            </span>
          </div>
        )}
      </div>

      {isOpen && (
        <div className="flex-1 flex flex-col min-h-0 bg-white">
          {/* 2. Session Specs: Chrome DevTools Network style key-value grid */}
          <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-white">
            <div className="flex items-center justify-between pb-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#64748B] font-mono flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-[#64748B]" />
                SESSION SPECS
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] inline-block" />
            </div>

            <div className="divide-y divide-[#F1F5F9] font-mono text-[13px]">
              <div className="flex justify-between items-center py-2">
                <span className="text-[#64748B]">Local Node</span>
                <span className="text-[#0F172A] font-medium">
                  {me || "peer"}:{tcpPort || "---"}
                </span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-[#64748B]">Remote Peer</span>
                <span className="text-[#0F172A] font-medium">{remoteAddr}</span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-[#64748B]">Encryption</span>
                <span className="inline-flex items-center gap-1.5 font-medium text-[#0F172A]">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      isEncrypted ? "bg-[#10B981]" : "bg-[#D97706]"
                    }`}
                  />
                  <span>{isEncrypted ? "AES-256 (E2E)" : "PLAINTEXT (STAGE 1)"}</span>
                </span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-[#64748B]">Auth / KDC</span>
                <span className="text-[#0F172A] font-medium">
                  {isEncrypted ? "KERBEROS TICKET (OK)" : "UNVERIFIED"}
                </span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-[#64748B]">Transport</span>
                <span className="text-[#0F172A] font-medium">DIRECT TCP • 64KB</span>
              </div>
            </div>
          </div>

          {/* 3. Controls & Filters */}
          {/* Row A: Heartbeat toggle + Buffer count (40px) */}
          <div className="h-[40px] min-h-[40px] px-4 border-b border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between text-[12px] font-mono">
            <button
              onClick={() => setHideHeartbeats(!hideHeartbeats)}
              className={`flex items-center space-x-1.5 px-2 py-0.5 rounded-[4px] border text-[12px] transition-colors ${
                hideHeartbeats
                  ? "bg-white border-[#CBD5E1] text-[#0F172A] font-medium"
                  : "bg-transparent border-transparent text-[#64748B] hover:bg-[#E2E8F0]/50"
              }`}
              title="Bật/Tắt ẩn các gói tin Heartbeat"
            >
              {hideHeartbeats ? (
                <EyeOff className="w-3.5 h-3.5 text-[#0F172A]" />
              ) : (
                <Eye className="w-3.5 h-3.5 text-[#64748B]" />
              )}
              <span>Ẩn Heartbeat</span>
              <span className="bg-[#E2E8F0] text-[#64748B] px-1.5 rounded-[3px] text-[11px]">
                {heartbeatCount}
              </span>
            </button>

            <span className="text-[#64748B] text-[12px]">
              Buffer: {logs.length}
            </span>
          </div>

          {/* Row B: Single-row Tab Bar with 2px bottom active border - 6 tabs fit cleanly in 440px */}
          <div className="border-b border-[#E2E8F0] bg-white px-3 flex items-center justify-between overflow-x-auto no-scrollbar">
            {(
              [
                { id: "ALL", label: "Tất cả" },
                { id: "DHT", label: "DHT/P2P" },
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
                  className={`px-2.5 py-2 text-[12.5px] font-mono whitespace-nowrap transition-colors relative cursor-pointer ${
                    isActive
                      ? "text-[#0F172A] font-semibold border-b-2 border-[#0F172A] -mb-[1px]"
                      : "text-[#64748B] hover:text-[#0F172A] border-b-2 border-transparent"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* 4. Log Entries List */}
          <div className="flex-1 overflow-y-auto divide-y divide-[#F1F5F9] font-mono bg-white">
            {filteredLogs.length === 0 ? (
              <div className="p-8 text-center text-[#64748B] space-y-1.5">
                <Activity className="w-5 h-5 text-[#94A3B8] mx-auto stroke-1" />
                <p className="text-xs font-mono uppercase font-semibold text-[#0F172A]">
                  Không có gói tin nào
                </p>
                {hideHeartbeats && heartbeatCount > 0 && (
                  <p className="text-[12px] text-[#64748B] font-sans">
                    Đang ẩn {heartbeatCount} gói Heartbeat. Bấm vào "Ẩn Heartbeat" để xem lại.
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
                    className={`px-4 py-2.5 cursor-pointer transition-colors border-l-2 ${
                      isSelected
                        ? "bg-[#F1F5F9] border-[#0F172A]"
                        : isHeartbeat
                        ? "opacity-50 hover:opacity-100 hover:bg-[#F8FAFC] border-transparent"
                        : "hover:bg-[#F8FAFC] border-transparent"
                    }`}
                  >
                    {/* Header Row: Time + Direction + Type */}
                    <div className="flex items-center justify-between text-[#64748B] mb-1 flex-wrap gap-1">
                      <span className="text-[12px] font-mono text-[#64748B]">
                        {log.timeStr.substring(11, 19)}
                      </span>

                      <div className="flex items-center space-x-1.5">
                        {log.direction === "IN" && (
                          <span className="flex items-center text-[#10B981] text-[11px] font-semibold">
                            <ArrowDownLeft className="w-3.5 h-3.5 mr-0.5" /> IN
                          </span>
                        )}
                        {log.direction === "OUT" && (
                          <span className="flex items-center text-[#0284C7] text-[11px] font-semibold">
                            <ArrowUpRight className="w-3.5 h-3.5 mr-0.5" /> OUT
                          </span>
                        )}
                        {log.direction === "INTERNAL" && (
                          <span className="flex items-center text-[#64748B] text-[11px] font-semibold">
                            <Cpu className="w-3.5 h-3.5 mr-0.5" /> SYS
                          </span>
                        )}

                        {getMessageTypeBadge(log.messageType, log.summary)}
                      </div>
                    </div>

                    {/* Summary Row */}
                    <div className="text-[13.5px] text-[#0F172A] break-words font-medium leading-relaxed font-mono">
                      {log.summary}
                    </div>

                    {/* Payload Inspector (DevTools Style) */}
                    {isSelected && log.details && (
                      <div className="mt-2.5 p-3 bg-[#F8FAFC] rounded-[6px] border border-[#E2E8F0] select-text space-y-2">
                        <div className="flex items-center justify-between pb-1.5 border-b border-[#E2E8F0] text-[11px] text-[#64748B]">
                          <span className="font-semibold text-[#0F172A] uppercase tracking-wider">
                            PAYLOAD INSPECTOR
                          </span>
                          <button
                            onClick={(e) => handleCopyPayload(log.id, log.details, e)}
                            className="flex items-center space-x-1 text-[#64748B] hover:text-[#0F172A] px-2 py-0.5 rounded-[4px] bg-white border border-[#E2E8F0] hover:bg-[#F1F5F9] transition-colors"
                            title="Sao chép JSON"
                          >
                            {copiedId === log.id ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-[#10B981]" />
                                <span className="text-[#10B981]">Đã chép</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy JSON</span>
                              </>
                            )}
                          </button>
                        </div>
                        <pre className="overflow-x-auto text-[11.5px] text-[#0F172A] leading-snug py-1">
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
