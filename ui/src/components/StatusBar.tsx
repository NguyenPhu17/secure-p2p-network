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
    <footer className="h-[32px] min-h-[32px] border-t border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B] text-[12px] font-mono select-none z-20 flex items-stretch justify-between px-3.5">
      {/* Left items separated by 1px solid #E2E8F0 vertical dividers */}
      <div className="flex items-stretch divide-x divide-[#E2E8F0] -ml-3.5">
        {/* TCP Port */}
        <div className="flex items-center space-x-2 px-3.5 hover:bg-[#F1F5F9] transition-colors">
          <Server className="w-3.5 h-3.5 text-[#64748B]" />
          <span>
            TCP LISTEN: <strong className="text-[#0F172A] font-medium">:{tcpPort || "---"}</strong>
          </span>
        </div>

        {/* MTU */}
        <div className="hidden sm:flex items-center space-x-2 px-3.5 hover:bg-[#F1F5F9] transition-colors">
          <Layers className="w-3.5 h-3.5 text-[#64748B]" />
          <span>
            MTU: <strong className="text-[#0F172A] font-medium">64KB</strong>
          </span>
        </div>

        {/* Socket */}
        <div className="hidden md:flex items-center space-x-2 px-3.5 hover:bg-[#F1F5F9] transition-colors">
          <Wifi className="w-3.5 h-3.5 text-[#64748B]" />
          <span>SOCKET: DIRECT P2P</span>
        </div>

        {/* Discovery */}
        <div className="hidden sm:flex items-center space-x-2 px-3.5 hover:bg-[#F1F5F9] transition-colors">
          <Radio className="w-3.5 h-3.5 text-[#64748B]" />
          <span>
            DISCOVERY: <strong className="text-[#0F172A] font-medium">DHT (KADEMLIA)</strong>
          </span>
        </div>

        {/* Encryption */}
        <div className="hidden lg:flex items-center space-x-2 px-3.5 hover:bg-[#F1F5F9] transition-colors">
          {isEncrypted ? (
            <>
              <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
              <span className="text-[#10B981] font-medium">ENC: AES-256 (E2E)</span>
            </>
          ) : (
            <>
              <ShieldAlert className="w-3.5 h-3.5 text-[#D97706]" />
              <span className="text-[#D97706] font-medium">ENC: PLAINTEXT</span>
            </>
          )}
        </div>
      </div>

      {/* Right items */}
      <div className="flex items-stretch border-l border-[#E2E8F0] -mr-3.5">
        <div className="flex items-center space-x-2 px-3.5 hover:bg-[#F1F5F9] transition-colors">
          <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] inline-block" />
          <Radio className="w-3.5 h-3.5 text-[#64748B]" />
          <span>
            PEERS ONLINE: <strong className="font-semibold text-[#0F172A]">{onlineCount}</strong>
          </span>
        </div>
      </div>
    </footer>
  );
};
