import React from 'react';
import { Shield, Server, Network, RefreshCw, Cpu } from 'lucide-react';
import { useNodeStateStore } from '../store/nodeStateStore';
import { usePacketStore } from '../store/packetStore';
import { StatusLight } from './shared/StatusLight';

export const Header: React.FC = () => {
  const { caStatus, fetchNodeStatus, fetchCaPeers } = useNodeStateStore();
  const { isConnected: isMitmWsConnected, refreshPackets } = usePacketStore();

  const handleGlobalRefresh = async () => {
    await fetchNodeStatus('node_a');
    await fetchNodeStatus('node_b');
    await fetchCaPeers();
    await refreshPackets();
  };

  return (
    <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur px-6 py-3.5 flex flex-col md:flex-row items-start md:items-center justify-between sticky top-0 z-40 gap-3">
      {/* Title & Concept */}
      <div className="flex items-center gap-3">
        <div className="bg-linear-to-tr from-cyan-500 to-blue-600 p-2.5 rounded-xl shadow-lg shadow-cyan-500/20">
          <Shield className="w-6 h-6 text-white" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold tracking-tight bg-linear-to-r from-cyan-400 via-sky-300 to-blue-400 bg-clip-text text-transparent">
              Hệ thống P2P Bảo mật & MITM Inspector
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-950 text-cyan-300 border border-cyan-800 font-semibold">
              Phase 4: Full Dashboard
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Các Hệ Thống Phân Tán · van Steen & Tanenbaum (§9.1–9.3 Mật mã, PKI & Bắt tay xác thực)
          </p>
        </div>
      </div>

      {/* Infrastructure Badges */}
      <div className="flex items-center gap-3 text-xs flex-wrap">
        {/* Docker Network */}
        <div className="hidden lg:flex items-center gap-1.5 bg-slate-950/70 border border-slate-800 rounded-lg px-2.5 py-1">
          <Cpu className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-slate-400">Network:</span>
          <span className="font-mono text-cyan-300 text-[11px]">p2p-secure-net</span>
        </div>

        {/* CA Server */}
        <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 rounded-lg px-2.5 py-1">
          <Server className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-slate-300 font-medium">CA Root:</span>
          <StatusLight
            status={caStatus.isOnline ? 'online' : 'offline'}
            label={caStatus.isOnline ? `Online (${caStatus.activePeers.length} peers)` : 'Offline'}
            size="sm"
          />
        </div>

        {/* MITM Proxy WS */}
        <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 rounded-lg px-2.5 py-1">
          <Network className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-slate-300 font-medium">MITM WS:</span>
          <StatusLight
            status={isMitmWsConnected ? 'online' : 'offline'}
            label={isMitmWsConnected ? 'Streaming' : 'Disconnected'}
            size="sm"
          />
        </div>

        {/* Sync Button */}
        <button
          onClick={handleGlobalRefresh}
          className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 active:scale-95 transition border border-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg"
          title="Đồng bộ trạng thái toàn bộ dịch vụ"
        >
          <RefreshCw className="w-3.5 h-3.5 text-cyan-400" />
          <span>Đồng bộ</span>
        </button>
      </div>
    </header>
  );
};
