import React from "react";
import { PeerInfo } from "../types";
import { Users, Wifi, Shield, Server, Radio } from "lucide-react";
import { getPeerColor } from "../utils/peerColors";

interface SidebarProps {
  me: string;
  tcpPort?: number;
  peers: PeerInfo[];
  activePeer: string | null;
  onSelectPeer: (peerName: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  me,
  tcpPort,
  peers,
  activePeer,
  onSelectPeer,
}) => {
  return (
    <aside className="w-68 lg:w-76 flex-shrink-0 border-r border-slate-200 bg-white flex flex-col h-full select-none">
      {/* Header thông tin Node hiện tại (Đồng bộ chiều cao h-13 min-h-[3.25rem]) */}
      <div className="h-13 min-h-[3.25rem] px-3.5 border-b border-slate-200 bg-slate-50/80 flex items-center justify-between">
        <div className="flex items-center space-x-2.5 truncate">
          <div className="relative flex-shrink-0">
            <div className="w-8 h-8 rounded-md bg-slate-900 text-white font-mono font-bold text-xs flex items-center justify-center">
              {me ? me.substring(0, 2).toUpperCase() : <Shield className="w-4 h-4 text-white" />}
            </div>
            <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-emerald-500 border border-white rounded-full" />
          </div>

          <div className="truncate min-w-0">
            <div className="flex items-center space-x-1.5">
              <span className="text-sm font-bold text-slate-900 truncate font-sans">
                {me || "Local Node"}
              </span>
              <span className="text-[10px] font-mono text-emerald-700 bg-emerald-50 border border-emerald-200 px-1 py-0.2 rounded font-bold">
                ONLINE
              </span>
            </div>
            <div className="text-[11px] font-mono text-slate-500 flex items-center gap-1.5 mt-0.5">
              <span>TCP :{tcpPort || "---"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tiêu đề danh sách Peer */}
      <div className="px-3.5 py-2 border-b border-slate-200 bg-slate-100/50 flex items-center justify-between text-[11px] font-mono font-bold uppercase tracking-wider text-slate-600">
        <span className="flex items-center space-x-1.5">
          <Radio className="w-3.5 h-3.5 text-slate-500" />
          <span>Active Peers</span>
        </span>
        <span className="font-mono text-[11px] text-slate-700 font-bold bg-slate-200 px-1.5 py-0.2 rounded">
          {peers.length}
        </span>
      </div>

      {/* Danh sách các Peer */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
        {peers.length === 0 ? (
          <div className="p-6 text-center text-slate-400 space-y-2">
            <div className="w-9 h-9 rounded-md bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 mx-auto">
              <Wifi className="w-4 h-4 stroke-1" />
            </div>
            <p className="text-xs font-mono font-bold text-slate-700 uppercase">
              No Peer Detected
            </p>
            <p className="text-[11px] text-slate-500 max-w-[200px] mx-auto leading-relaxed font-sans">
              Khởi động thêm node thứ hai (ví dụ: Bob trên cổng 3002) để kết nối P2P.
            </p>
          </div>
        ) : (
          peers.map((peer) => {
            const isActive = activePeer === peer.displayName;
            const peerColor = getPeerColor(peer.displayName);

            return (
              <button
                key={peer.displayName}
                onClick={() => onSelectPeer(peer.displayName)}
                className={`w-full text-left px-3.5 py-2.5 transition-colors flex items-center justify-between border-l-2 ${
                  isActive
                    ? "bg-slate-100 border-slate-900 text-slate-900 font-medium"
                    : "border-transparent hover:bg-slate-50 text-slate-700"
                }`}
              >
                <div className="flex items-center space-x-3 truncate">
                  <div className="relative flex-shrink-0">
                    <div
                      className={`w-8 h-8 rounded-md flex items-center justify-center text-xs font-mono font-bold uppercase ${peerColor.bg} ${peerColor.text}`}
                    >
                      {peer.displayName.substring(0, 2)}
                    </div>
                    <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-emerald-500 border border-white rounded-full" />
                  </div>

                  <div className="truncate">
                    <div className="text-sm font-semibold text-slate-900 truncate font-sans">
                      {peer.displayName}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono mt-0.5 font-normal flex items-center gap-1.5 truncate">
                      <span>{peer.ip}:{peer.tcpPort}</span>
                      {peer.nodeId && (
                        <span className="text-[10px] bg-slate-100 text-teal-700 font-semibold px-1 py-0.2 rounded border border-slate-200" title={`DHT Node ID: ${peer.nodeId}`}>
                          ID:{peer.nodeId.substring(0, 6)}
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
