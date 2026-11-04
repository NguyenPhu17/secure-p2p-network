import React from 'react';
import {
  ShieldAlert,
  RotateCcw,
  UserX,
  FastForward,
  Trash2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { usePacketStore } from '../../store/packetStore';

export const AttackToolbar: React.FC = () => {
  const {
    mode,
    setMode,
    heldPackets,
    selectedPacketId,
    tamperPacket,
    replayPacket,
    spoofPacket,
    releasePacket,
    clearPackets,
    isAttacking,
    attackError,
  } = usePacketStore();

  const isHoldMode = mode === 'hold';
  const hasHeldPackets = heldPackets.length > 0;
  const targetPacketId = selectedPacketId || (hasHeldPackets ? heldPackets[0].packet_id : undefined);

  const toggleMode = () => {
    setMode(isHoldMode ? 'passthrough' : 'hold');
  };

  const handleTamper = async () => {
    try {
      await tamperPacket(targetPacketId);
    } catch (err: any) {
      alert(`Tamper Attack failed: ${err.message}`);
    }
  };

  const handleReplay = async () => {
    try {
      await replayPacket(targetPacketId);
    } catch (err: any) {
      alert(`Replay Attack failed: ${err.message}`);
    }
  };

  const handleSpoof = async () => {
    try {
      await spoofPacket(targetPacketId, 'ROGUE_CA');
    } catch (err: any) {
      alert(`Spoof Identity Attack failed: ${err.message}`);
    }
  };

  const handleRelease = async () => {
    try {
      await releasePacket(targetPacketId);
    } catch (err: any) {
      alert(`Release failed: ${err.message}`);
    }
  };

  return (
    <div className="p-3 bg-slate-950/80 border border-amber-950/50 rounded-xl space-y-3">
      {/* Top row: Mode toggle + Clear */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={toggleMode}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition active:scale-95 shadow-md ${
              isHoldMode
                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-500/20'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
            }`}
          >
            {isHoldMode ? (
              <>
                <PauseCircle className="w-3.5 h-3.5 text-slate-950" />
                <span>Chế độ Giữ lại (Hold ON)</span>
              </>
            ) : (
              <>
                <PlayCircle className="w-3.5 h-3.5 text-emerald-400" />
                <span>Chuyển thẳng (Passthrough)</span>
              </>
            )}
          </button>

          {hasHeldPackets && (
            <span className="px-2 py-0.5 rounded-full text-[11px] font-mono font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse">
              {heldPackets.length} gói tin đang bị giữ
            </span>
          )}
        </div>

        <button
          onClick={clearPackets}
          className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-900 rounded transition"
          title="Xóa bộ đệm gói tin"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Attack Buttons (§9.1.1) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {/* Attack 1: Tamper Data */}
        <button
          onClick={handleTamper}
          disabled={isAttacking}
          className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-linear-to-b from-rose-950/40 to-slate-900 border border-rose-900/60 hover:border-rose-500 text-rose-300 hover:text-white transition active:scale-95 disabled:opacity-40 shadow-sm group"
          title="Kịch bản 1: Lật 1 bit trên Ciphertext để kiểm tra tính toàn vẹn (AES-GCM Auth Tag Mismatch)"
        >
          <ShieldAlert className="w-4 h-4 text-rose-400 mb-1 group-hover:scale-110 transition" />
          <span className="text-xs font-bold">1. Tamper Data</span>
          <span className="text-[10px] text-slate-400 font-sans mt-0.5">Lật bit Ciphertext</span>
        </button>

        {/* Attack 2: Replay Attack */}
        <button
          onClick={handleReplay}
          disabled={isAttacking}
          className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-linear-to-b from-purple-950/40 to-slate-900 border border-purple-900/60 hover:border-purple-500 text-purple-300 hover:text-white transition active:scale-95 disabled:opacity-40 shadow-sm group"
          title="Kịch bản 2: Gửi lại gói tin cũ để kiểm tra lớp chống phát lại (Nonce / Timestamp)"
        >
          <RotateCcw className="w-4 h-4 text-purple-400 mb-1 group-hover:scale-110 transition" />
          <span className="text-xs font-bold">2. Replay Attack</span>
          <span className="text-[10px] text-slate-400 font-sans mt-0.5">Phát lại gói cũ</span>
        </button>

        {/* Attack 3: Spoof Identity */}
        <button
          onClick={handleSpoof}
          disabled={isAttacking}
          className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-linear-to-b from-orange-950/40 to-slate-900 border border-orange-900/60 hover:border-orange-500 text-orange-300 hover:text-white transition active:scale-95 disabled:opacity-40 shadow-sm group"
          title="Kịch bản 3: Thay thế X.509 Certificate bằng chứng chỉ giả mạo Rogue CA"
        >
          <UserX className="w-4 h-4 text-orange-400 mb-1 group-hover:scale-110 transition" />
          <span className="text-xs font-bold">3. Spoof Identity</span>
          <span className="text-[10px] text-slate-400 font-sans mt-0.5">Tráo Cert Rogue CA</span>
        </button>

        {/* Action 4: Release */}
        <button
          onClick={handleRelease}
          disabled={isAttacking || !hasHeldPackets}
          className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-linear-to-b from-emerald-950/40 to-slate-900 border border-emerald-900/60 hover:border-emerald-500 text-emerald-300 hover:text-white transition active:scale-95 disabled:opacity-40 shadow-sm group"
          title="Cho phép gói tin đang bị giữ tiếp tục chuyển tiếp bình thường"
        >
          <FastForward className="w-4 h-4 text-emerald-400 mb-1 group-hover:scale-110 transition" />
          <span className="text-xs font-bold">Release (Cho qua)</span>
          <span className="text-[10px] text-slate-400 font-sans mt-0.5">Forward nguyên gốc</span>
        </button>
      </div>

      {isAttacking && (
        <div className="flex items-center justify-center gap-2 p-2 bg-slate-900 border border-slate-800 rounded-lg text-xs text-amber-300">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          <span>Đang thực thi kịch bản tấn công và theo dõi phản hồi từ Node nhận...</span>
        </div>
      )}

      {attackError && (
        <div className="flex items-center gap-1.5 p-2 bg-rose-950/40 border border-rose-800 rounded-lg text-xs text-rose-300">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
          <span>{attackError}</span>
        </div>
      )}
    </div>
  );
};
