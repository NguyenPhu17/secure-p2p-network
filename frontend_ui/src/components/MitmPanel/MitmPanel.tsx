import React from 'react';
import { Network } from 'lucide-react';
import { usePacketStore } from '../../store/packetStore';
import { StatusLight } from '../shared/StatusLight';
import { MessageSequenceChart } from './MessageSequenceChart';
import { AttackToolbar } from './AttackToolbar';
import { PacketList } from './PacketList';
import { PacketInspector } from './PacketInspector';

export const MitmPanel: React.FC = () => {
  const { isConnected, packets, heldPackets } = usePacketStore();

  return (
    <section className="flex flex-col gap-4">
      <div className="bg-slate-900/90 border border-amber-950/40 rounded-2xl p-4 shadow-xl flex-1 flex flex-col ring-1 ring-amber-500/20 space-y-4">
        {/* Panel Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-400">
              <Network className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-sm text-slate-100">
                  Cột 2: MITM Proxy & Network Inspector
                </h2>
                <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-amber-950 text-amber-300 border border-amber-800">
                  Port 8080
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono">
                Reverse Relay · Intercept (§9.1.1) · {packets.length} gói tin đã bắt
              </p>
            </div>
          </div>

          <StatusLight
            status={isConnected ? (heldPackets.length > 0 ? 'held' : 'healthy') : 'offline'}
            label={
              isConnected
                ? heldPackets.length > 0
                  ? `${heldPackets.length} Giữ lại`
                  : 'Hoạt động'
                : 'Mất kết nối'
            }
          />
        </div>

        {/* 1. Animated Message Sequence Flow */}
        <MessageSequenceChart />

        {/* 2. Attack Control & Scenario Buttons */}
        <AttackToolbar />

        {/* 3. Intercepted Packets List */}
        <PacketList />

        {/* 4. Deep Packet Inspector with Cryptographic Analysis */}
        <PacketInspector />
      </div>
    </section>
  );
};
