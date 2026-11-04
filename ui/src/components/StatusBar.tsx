import React from "react";
import { Server, Layers, Wifi, ShieldCheck, ShieldAlert, Radio } from "lucide-react";

interface StatusBarProps {
  channelStatus?: string;
  tcpPort: number;
  onlineCount: number;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  channelStatus = "Plaintext",
  tcpPort,
  onlineCount,
}) => {
  const isEncrypted =
    !channelStatus.toLowerCase().includes("plaintext") &&
    !channelStatus.toLowerCase().includes("chưa mã hóa");

  return (
    <footer className="h-7 min-h-[1.75rem] border-t border-slate-200 bg-slate-100/90 text-slate-600 text-[11px] font-mono select-none z-20 flex items-stretch justify-between">
      {/* Phân vùng thông số bên trái: Dùng kiểu chia vạch phẳng phiu (divide-x) chuẩn VS Code */}
      <div className="flex items-stretch divide-x divide-slate-200">
        {/* Cổng TCP Listen */}
        <div className="flex items-center space-x-1.5 px-3 hover:bg-slate-200/50 transition-colors">
          <Server className="w-3 h-3 text-slate-500" />
          <span>
            TCP LISTEN: <strong className="text-slate-900 font-bold">:{tcpPort || "---"}</strong>
          </span>
        </div>

        {/* Thông số MTU */}
        <div className="hidden sm:flex items-center space-x-1.5 px-3 hover:bg-slate-200/50 transition-colors">
          <Layers className="w-3 h-3 text-slate-500" />
          <span>
            MTU: <strong className="text-slate-800 font-semibold">64KB</strong>
          </span>
        </div>

        {/* Chế độ truyền */}
        <div className="hidden md:flex items-center space-x-1.5 px-3 hover:bg-slate-200/50 transition-colors">
          <Wifi className="w-3 h-3 text-slate-500" />
          <span>SOCKET: DIRECT P2P</span>
        </div>

        {/* Trạng thái bảo mật */}
        <div className="hidden lg:flex items-center space-x-1.5 px-3 hover:bg-slate-200/50 transition-colors">
          {isEncrypted ? (
            <>
              <ShieldCheck className="w-3 h-3 text-emerald-600" />
              <span className="text-emerald-700 font-semibold">ENC: AES-256 (E2E)</span>
            </>
          ) : (
            <>
              <ShieldAlert className="w-3 h-3 text-amber-600" />
              <span className="text-amber-800 font-medium">ENC: NONE (PLAINTEXT)</span>
            </>
          )}
        </div>
      </div>

      {/* Phân vùng trạng thái bên phải */}
      <div className="flex items-stretch border-l border-slate-200">
        <div className="flex items-center space-x-2 px-3 hover:bg-slate-200/50 transition-colors">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block animate-pulse" />
          <Radio className="w-3 h-3 text-slate-500" />
          <span>
            PEERS ONLINE: <strong className="font-bold text-slate-900">{onlineCount}</strong>
          </span>
        </div>
      </div>
    </footer>
  );
};
