import React from 'react';
import { ListFilter, CheckCircle, Clock, PauseCircle, ShieldAlert } from 'lucide-react';
import { usePacketStore } from '../../store/packetStore';
import type { PacketStatus } from '../../types/protocol';

export const PacketList: React.FC = () => {
  const {
    packets,
    selectedPacketId,
    setSelectedPacketId,
    filterType,
    setFilterType,
    filterStatus,
    setFilterStatus,
  } = usePacketStore();

  const filteredPackets = packets.filter((pkt) => {
    if (filterType !== 'ALL' && pkt.packet_type !== filterType) return false;
    if (filterStatus !== 'ALL' && pkt.status !== filterStatus) return false;
    return true;
  });

  return (
    <div className="space-y-2 flex flex-col flex-1 min-h-[220px]">
      {/* Filter Toolbar */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5 text-slate-300 font-medium">
          <ListFilter className="w-3.5 h-3.5 text-cyan-400" />
          <span>Danh sách Gói tin Bắt được ({filteredPackets.length})</span>
        </div>

        <div className="flex items-center gap-1.5">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[11px] text-slate-300 focus:outline-hidden"
          >
            <option value="ALL">Mọi loại gói</option>
            <option value="HANDSHAKE_INIT">HANDSHAKE_INIT</option>
            <option value="HANDSHAKE_RESPOND">HANDSHAKE_RESPOND</option>
            <option value="HANDSHAKE_CONFIRM">HANDSHAKE_CONFIRM</option>
            <option value="SESSION_KEY_EXCHANGE">SESSION_KEY_EXCHANGE</option>
            <option value="SECURE_MESSAGE">SECURE_MESSAGE</option>
            <option value="SECURE_FILE">SECURE_FILE</option>
          </select>

          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-[11px] text-slate-300 focus:outline-hidden"
          >
            <option value="ALL">Mọi trạng thái</option>
            <option value="HELD">Đang giữ (HELD)</option>
            <option value="FORWARDED">Đã chuyển (FORWARDED)</option>
            <option value="TAMPERED">Đã sửa bit (TAMPERED)</option>
            <option value="REPLAYED">Đã phát lại (REPLAYED)</option>
            <option value="SPOOFED">Đã giả mạo (SPOOFED)</option>
          </select>
        </div>
      </div>

      {/* Packet Table / Rows */}
      <div className="flex-1 overflow-y-auto space-y-1.5 max-h-[260px] pr-1">
        {filteredPackets.length === 0 ? (
          <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl text-center text-xs text-slate-500">
            Chưa có gói tin nào khớp bộ lọc.
          </div>
        ) : (
          filteredPackets.map((pkt) => {
            const isSelected = selectedPacketId === pkt.packet_id;
            return (
              <div
                key={pkt.packet_id}
                onClick={() => setSelectedPacketId(pkt.packet_id)}
                className={`p-2.5 rounded-xl border transition cursor-pointer select-none text-xs ${
                  isSelected
                    ? 'bg-slate-900 border-cyan-500 shadow-md ring-1 ring-cyan-500/20'
                    : 'bg-slate-950/70 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 overflow-hidden mr-2">
                    <span className="font-mono font-bold text-slate-200 truncate">
                      {pkt.packet_type}
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">
                      #{pkt.packet_id.slice(0, 8)}
                    </span>
                  </div>
                  <PacketStatusBadge status={pkt.status} />
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                  <div className="flex items-center gap-1">
                    <span className="text-cyan-400">{pkt.direction}</span>
                  </div>
                  <div className="flex items-center gap-1 text-slate-500 text-[10px]">
                    <Clock className="w-3 h-3" />
                    <span>{new Date(pkt.intercepted_at).toLocaleTimeString()}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export function PacketStatusBadge({ status }: { status: PacketStatus }) {
  if (status === 'HELD') {
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse flex items-center gap-1">
        <PauseCircle className="w-2.5 h-2.5" />
        HELD
      </span>
    );
  }
  if (status === 'FORWARDED') {
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
        <CheckCircle className="w-2.5 h-2.5" />
        FORWARDED
      </span>
    );
  }
  if (status === 'TAMPERED') {
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40 flex items-center gap-1">
        <ShieldAlert className="w-2.5 h-2.5" />
        TAMPERED
      </span>
    );
  }
  if (status === 'REPLAYED') {
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40">
        REPLAYED
      </span>
    );
  }
  if (status === 'SPOOFED') {
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-orange-500/20 text-orange-300 border border-orange-500/40">
        SPOOFED
      </span>
    );
  }
  return <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-400">{status}</span>;
}
