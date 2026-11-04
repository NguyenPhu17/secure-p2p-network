import React, { useEffect, useState } from 'react';
import { Network, ShieldAlert, ArrowRight } from 'lucide-react';
import { usePacketStore } from '../../store/packetStore';
import type { PacketFlowEvent } from '../../store/packetStore';

export const MessageSequenceChart: React.FC = () => {
  const { lastFlowEvent, mode } = usePacketStore();
  const [animatingEvent, setAnimatingEvent] = useState<PacketFlowEvent | null>(null);

  useEffect(() => {
    if (!lastFlowEvent) return;
    const startTimer = setTimeout(() => {
      setAnimatingEvent(lastFlowEvent);
    }, 0);

    const endTimer = setTimeout(() => {
      setAnimatingEvent(null);
    }, 3500);

    return () => {
      clearTimeout(startTimer);
      clearTimeout(endTimer);
    };
  }, [lastFlowEvent]);

  return (
    <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-slate-300 font-medium">
          <Network className="w-3.5 h-3.5 text-amber-400" />
          <span>Message Sequence Flow Diagram (§9.1.1 — Active MITM Relay)</span>
        </div>
        <span
          className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${
            mode === 'hold'
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse'
              : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
          }`}
        >
          {mode === 'hold' ? 'Intercept Mode (Hold)' : 'Passthrough Mode'}
        </span>
      </div>

      {/* SVG Diagram */}
      <div className="relative w-full h-32 bg-slate-900/60 border border-slate-800/80 rounded-lg overflow-hidden flex flex-col justify-between p-2">
        {/* Nodes Line */}
        <div className="flex justify-between items-center px-4 pt-1 z-10">
          <div className="flex flex-col items-center">
            <div className="px-2.5 py-1 rounded bg-blue-950 border border-blue-600 text-blue-300 font-mono text-[11px] font-bold shadow-sm">
              Node A
            </div>
            <span className="text-[10px] text-slate-500 mt-0.5 font-mono">Port 8001</span>
          </div>

          <div className="flex flex-col items-center">
            <div className="px-2.5 py-1 rounded bg-amber-950 border border-amber-500 text-amber-300 font-mono text-[11px] font-bold shadow-sm flex items-center gap-1">
              <span>MITM Proxy</span>
            </div>
            <span className="text-[10px] text-slate-500 mt-0.5 font-mono">Port 8080</span>
          </div>

          <div className="flex flex-col items-center">
            <div className="px-2.5 py-1 rounded bg-emerald-950 border border-emerald-600 text-emerald-300 font-mono text-[11px] font-bold shadow-sm">
              Node B
            </div>
            <span className="text-[10px] text-slate-500 mt-0.5 font-mono">Port 8002</span>
          </div>
        </div>

        {/* Dynamic Route Visualization */}
        <div className="relative flex-1 flex items-center justify-center my-1">
          {/* Static Background Guide Track */}
          <div className="absolute inset-x-12 h-0.5 bg-slate-800 flex items-center justify-between">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500"></div>
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
          </div>

          {/* Animated Flow Bubble */}
          {animatingEvent ? (
            <div
              className={`absolute px-2.5 py-1 rounded-full text-[10px] font-mono font-semibold flex items-center gap-1 shadow-lg transition-all duration-1000 z-20 ${
                animatingEvent.isAttack
                  ? 'bg-rose-500 text-white border border-rose-400 animate-bounce'
                  : animatingEvent.status === 'HELD'
                  ? 'bg-amber-500 text-slate-950 border border-amber-300 animate-pulse'
                  : 'bg-cyan-500 text-slate-950 border border-cyan-300'
              }`}
            >
              {animatingEvent.isAttack ? (
                <ShieldAlert className="w-3 h-3 text-white" />
              ) : (
                <ArrowRight className="w-3 h-3" />
              )}
              <span>{animatingEvent.packetType}</span>
              <span className="text-[9px] opacity-80">({animatingEvent.status})</span>
            </div>
          ) : (
            <div className="text-[11px] text-slate-500 font-mono italic">
              Đang chờ lưu lượng mạng truyền qua Proxy...
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="flex justify-between items-center px-3 text-[10px] text-slate-400 border-t border-slate-800/60 pt-1">
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
            <span>Giao thức chuẩn</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-400"></span>
            <span>Bắt giữ (Hold)</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-rose-500"></span>
            <span>Mô phỏng Tấn công</span>
          </div>
        </div>
      </div>
    </div>
  );
};
