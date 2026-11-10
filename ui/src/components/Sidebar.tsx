import React from "react";
import { PeerInfo } from "../types";
import { Wifi, Shield, Radio } from "lucide-react";

interface SidebarProps {
  me: string;
  tcpPort?: number;
  peers: PeerInfo[];
  blockedPeers?: string[];
  activePeer: string | null;
  onSelectPeer: (peerName: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  me,
  tcpPort,
  peers,
  blockedPeers = [],
  activePeer,
  onSelectPeer,
}) => {
  return (
    <aside className="w-[280px] xl:w-[300px] flex-shrink-0 border-r border-[#E2E8F0] bg-[#F8FAFC] flex flex-col h-full select-none">
      {/* Header: Local Node Info (64px) */}
      <div className="h-[64px] min-h-[64px] px-4 border-b border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between">
        <div className="flex items-center space-x-3 min-w-0">
          <div className="relative flex-shrink-0">
            <div className="w-9 h-9 rounded-[8px] bg-[#E2E8F0] text-[#0F172A] font-mono font-bold text-[13px] flex items-center justify-center">
              {me ? me.substring(0, 2).toUpperCase() : <Shield className="w-4 h-4 text-[#0F172A]" />}
            </div>
            <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-[#10B981] rounded-full ring-2 ring-[#F8FAFC]" />
          </div>

          <div className="min-w-0 truncate">
            <div className="text-[14.5px] font-semibold text-[#0F172A] truncate font-sans leading-tight">
              {me || "Local Node"}
            </div>
            <div className="text-[12px] font-mono text-[#64748B] flex items-center gap-1.5 mt-0.5">
              <span>:{tcpPort || "---"}</span>
              <span className="text-[#CBD5E1]">|</span>
              <span className="text-[#10B981] font-medium text-[11px]">LISTENING</span>
            </div>
          </div>
        </div>
      </div>

      {/* Sub-header: Active Peers count (40px) */}
      <div className="h-[40px] min-h-[40px] px-4 border-b border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between text-[12px] font-mono font-medium uppercase tracking-wider text-[#64748B]">
        <span className="flex items-center space-x-1.5">
          <Radio className="w-3.5 h-3.5 text-[#64748B]" />
          <span>Peers</span>
        </span>
        <span
          className="font-mono text-[11px] text-[#0F172A] font-semibold bg-[#E2E8F0] px-2 py-0.5 rounded-[4px]"
          title="Số peer đang online / Tổng số peer đã biết"
        >
          {peers.filter((p) => p.online !== false).length}/{peers.length}
        </span>
      </div>

      {/* Peers List */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#F1F5F9] bg-[#FFFFFF]">
        {peers.length === 0 ? (
          <div className="p-6 text-center text-[#64748B] space-y-2">
            <div className="w-9 h-9 rounded-[8px] bg-[#F1F5F9] border border-[#E2E8F0] flex items-center justify-center text-[#64748B] mx-auto">
              <Wifi className="w-4 h-4" />
            </div>
            <p className="text-[12px] font-mono font-semibold text-[#0F172A] uppercase">
              No Peer Connected
            </p>
            <p className="text-[12px] text-[#64748B] max-w-[220px] mx-auto leading-relaxed font-sans">
              Khởi động thêm node thứ hai (ví dụ: Bob trên cổng 3002) để kết nối P2P.
            </p>
          </div>
        ) : (
          peers.map((peer) => {
            const isActive = activePeer === peer.displayName;
            const isOnline = peer.online !== false;
            const isBlocked = blockedPeers.includes(peer.displayName);
            const peerKey = peer.nodeId || `${peer.ip}:${peer.tcpPort}` || peer.displayName;

            return (
              <button
                key={peerKey}
                onClick={() => onSelectPeer(peer.displayName)}
                className={`w-full text-left px-4 py-3 transition-colors flex items-center justify-between border-l-2 ${
                  isActive
                    ? "bg-[#F1F5F9] border-[#0F172A] text-[#0F172A]"
                    : "border-transparent hover:bg-[#F8FAFC] text-[#64748B]"
                }`}
              >
                <div className="flex items-center space-x-3 min-w-0 w-full">
                  <div className="relative flex-shrink-0">
                    <div
                      className={`w-10 h-10 rounded-[8px] font-mono font-bold text-[14px] flex items-center justify-center uppercase ${
                        isOnline ? "bg-[#E2E8F0] text-[#0F172A]" : "bg-[#F1F5F9] text-[#64748B]"
                      }`}
                    >
                      {peer.displayName.substring(0, 2)}
                    </div>
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-white ${
                        isBlocked ? "bg-[#F59E0B]" : isOnline ? "bg-[#10B981]" : "bg-[#94A3B8]"
                      }`}
                    />
                  </div>

                  <div className="min-w-0 flex-1 truncate">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[15px] font-semibold text-[#0F172A] truncate font-sans leading-tight">
                        {peer.displayName}
                      </span>
                      {isBlocked ? (
                        <span
                          className="text-[10px] font-mono font-medium uppercase px-1.5 py-0.5 rounded-[3px] bg-[#FFFBEB] text-[#B45309] border border-[#FDE68A] flex-shrink-0"
                          title="Direct TCP bị chặn bởi Firewall/NAT - Đang định tuyến qua Mesh Relay"
                        >
                          RELAY
                        </span>
                      ) : (
                        !isOnline && (
                          <span className="text-[10px] font-mono font-medium uppercase px-1.5 py-0.5 rounded-[3px] bg-[#F1F5F9] text-[#64748B] border border-[#E2E8F0] flex-shrink-0">
                            OFFLINE
                          </span>
                        )
                      )}
                    </div>
                    <div className="text-[12.5px] text-[#64748B] font-mono mt-0.5 font-normal flex items-center gap-1.5 truncate">
                      <span>{peer.tcpPort > 0 ? `${peer.ip}:${peer.tcpPort}` : "Offline • DHT Mailbox"}</span>
                      {peer.nodeId && (
                        <span
                          className="text-[11px] bg-[#F1F5F9] text-[#64748B] px-1.5 py-0.2 rounded-[3px] border border-[#E2E8F0]"
                          title={`DHT Node ID: ${peer.nodeId}`}
                        >
                          #{peer.nodeId.substring(0, 4)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
};
