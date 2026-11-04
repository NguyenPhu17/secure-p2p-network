import React, { useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  RotateCcw,
  UserX,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { useNodeStateStore } from '../store/nodeStateStore';
import { usePacketStore } from '../store/packetStore';

export const ScenarioBar: React.FC = () => {
  const {
    connectPeerToPeer,
    sendSecureMessage,
    clearSecurityAlert,
  } = useNodeStateStore();

  const {
    setMode,
    tamperPacket,
    replayPacket,
    spoofPacket,
    refreshPackets,
  } = usePacketStore();

  const [runningScenario, setRunningScenario] = useState<string | null>(null);

  // Scenario 1: Normal Encrypted Transmission
  const runNormalChatDemo = async () => {
    setRunningScenario('normal');
    clearSecurityAlert('node_b');
    try {
      // 1. Ensure passthrough mode
      await setMode('passthrough');
      // 2. Ensure handshake
      await connectPeerToPeer('node_a', 'node_b');
      // 3. Send message
      await sendSecureMessage('node_a', 'node_b', 'Bản tin an toàn: van Steen §9.2 Xác thực và Bảo mật Toàn vẹn.');
      await refreshPackets();
    } catch (err: any) {
      alert(`Normal Demo error: ${err.message}`);
    } finally {
      setRunningScenario(null);
    }
  };

  // Scenario 2: Tamper Attack Demo
  const runTamperDemo = async () => {
    setRunningScenario('tamper');
    clearSecurityAlert('node_b');
    try {
      // Put in hold mode
      await setMode('hold');
      // Send message from A (which will be intercepted by Proxy in HOLD mode)
      await sendSecureMessage('node_a', 'node_b', 'Bí mật chuyển khoản: Chuyển 100,000 USD tới tài khoản VIP.');
      // Wait a moment for packet to be held
      await new Promise((r) => setTimeout(r, 600));
      // Execute Tamper (flip bit in ciphertext)
      await tamperPacket();
      // Restore passthrough mode
      await setMode('passthrough');
    } catch (err: any) {
      alert(`Tamper Demo error: ${err.message}`);
    } finally {
      setRunningScenario(null);
    }
  };

  // Scenario 3: Replay Attack Demo
  const runReplayDemo = async () => {
    setRunningScenario('replay');
    clearSecurityAlert('node_b');
    try {
      // Replay latest valid packet from packet history
      await replayPacket();
    } catch (err: any) {
      alert(`Replay Demo error: ${err.message}`);
    } finally {
      setRunningScenario(null);
    }
  };

  // Scenario 4: Spoof Identity Demo
  const runSpoofDemo = async () => {
    setRunningScenario('spoof');
    clearSecurityAlert('node_b');
    try {
      // Execute spoof attack swapping cert with Rogue CA
      await spoofPacket(undefined, 'ROGUE_CA');
    } catch (err: any) {
      alert(`Spoof Demo error: ${err.message}`);
    } finally {
      setRunningScenario(null);
    }
  };

  return (
    <div className="bg-slate-900/90 border-b border-slate-800 px-6 py-2.5 flex items-center justify-between text-xs overflow-x-auto gap-4">
      <div className="flex items-center gap-2 shrink-0">
        <div className="p-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400">
          <Sparkles className="w-4 h-4" />
        </div>
        <div>
          <span className="font-bold text-slate-200">Kịch bản Trực quan (§9.1–9.3):</span>
          <span className="text-[11px] text-slate-400 ml-1.5 hidden sm:inline">
            1-Click Demo Kiểm thử Bảo mật & Tấn công MITM
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {/* Scenario 1 */}
        <button
          onClick={runNormalChatDemo}
          disabled={runningScenario !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/50 border border-emerald-800/80 text-emerald-300 font-medium transition active:scale-95 disabled:opacity-50"
        >
          {runningScenario === 'normal' ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-400" />
          ) : (
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          )}
          <span>Demo 1: Truyền An toàn (3/3 Pass)</span>
        </button>

        {/* Scenario 2 */}
        <button
          onClick={runTamperDemo}
          disabled={runningScenario !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/50 border border-rose-800/80 text-rose-300 font-medium transition active:scale-95 disabled:opacity-50"
        >
          {runningScenario === 'tamper' ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-rose-400" />
          ) : (
            <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
          )}
          <span>Demo 2: Tấn công Sửa Bit (GCM Tag Mismatch)</span>
        </button>

        {/* Scenario 3 */}
        <button
          onClick={runReplayDemo}
          disabled={runningScenario !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-950/40 hover:bg-purple-900/50 border border-purple-800/80 text-purple-300 font-medium transition active:scale-95 disabled:opacity-50"
        >
          {runningScenario === 'replay' ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-purple-400" />
          ) : (
            <RotateCcw className="w-3.5 h-3.5 text-purple-400" />
          )}
          <span>Demo 3: Tấn công Phát lại (Anti-Replay Alert)</span>
        </button>

        {/* Scenario 4 */}
        <button
          onClick={runSpoofDemo}
          disabled={runningScenario !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-950/40 hover:bg-orange-900/50 border border-orange-800/80 text-orange-300 font-medium transition active:scale-95 disabled:opacity-50"
        >
          {runningScenario === 'spoof' ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-orange-400" />
          ) : (
            <UserX className="w-3.5 h-3.5 text-orange-400" />
          )}
          <span>Demo 4: Giả mạo Chứng chỉ (Rogue CA Alert)</span>
        </button>
      </div>
    </div>
  );
};
