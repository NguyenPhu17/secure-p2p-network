import React, { useState } from 'react';
import { ShieldCheck, RefreshCw, Zap, CheckCircle2, AlertCircle } from 'lucide-react';
import { useNodeStateStore } from '../../store/nodeStateStore';

interface HandshakeControlProps {
  nodeId: 'node_a' | 'node_b';
}

export const HandshakeControl: React.FC<HandshakeControlProps> = ({ nodeId }) => {
  const {
    nodeA,
    nodeB,
    caStatus,
    isHandshaking,
    connectPeerToPeer,
    fetchCaPeers,
  } = useNodeStateStore();

  const currentNode = nodeId === 'node_a' ? nodeA : nodeB;
  const targetIdDefault = nodeId === 'node_a' ? 'node_b' : 'node_a';
  const [selectedTarget, setSelectedTarget] = useState(targetIdDefault);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const hasActiveSession = currentNode.sessions.some((s) => s.peer_id === selectedTarget);

  const handleConnect = async () => {
    setResultMessage(null);
    try {
      await connectPeerToPeer(nodeId, selectedTarget);
      setResultMessage(`Mutual Authentication & Session Key Established with ${selectedTarget}!`);
      setTimeout(() => setResultMessage(null), 4000);
    } catch (err: any) {
      setResultMessage(`Handshake failed: ${err.message}`);
    }
  };

  return (
    <div className="p-3.5 bg-slate-950/70 border border-slate-800 rounded-xl space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-slate-300 font-medium">
          <Zap className="w-3.5 h-3.5 text-amber-400" />
          <span>Mutual Authentication Handshake (§9.3.2)</span>
        </div>
        <button
          onClick={fetchCaPeers}
          className="text-slate-500 hover:text-slate-300 transition text-[11px] flex items-center gap-1"
          title="Refresh peer discovery from CA"
        >
          <RefreshCw className="w-3 h-3" />
          <span>Sync CA</span>
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="block text-[11px] text-slate-400 mb-1">Target Peer</label>
          <select
            value={selectedTarget}
            onChange={(e) => setSelectedTarget(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-hidden focus:border-cyan-500 transition font-mono"
          >
            <option value="node_b">node_b (Port 8002)</option>
            <option value="node_a">node_a (Port 8001)</option>
            <option value="node_c">node_c (Port 8003)</option>
            {caStatus.activePeers
              .filter((p) => p.peer_id !== nodeId && !['node_a', 'node_b', 'node_c'].includes(p.peer_id))
              .map((p) => (
                <option key={p.peer_id} value={p.peer_id}>
                  {p.peer_id}
                </option>
              ))}
          </select>
        </div>

        <div className="shrink-0 pt-4">
          <button
            onClick={handleConnect}
            disabled={isHandshaking || !currentNode.isOnline}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition shadow-md active:scale-95 ${
              hasActiveSession
                ? 'bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-emerald-500/30'
                : 'bg-linear-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-cyan-500/20'
            } disabled:opacity-50 disabled:pointer-events-none`}
          >
            {isHandshaking ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Bắt tay...</span>
              </>
            ) : hasActiveSession ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Tái bắt tay</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Bắt tay & Xác thực</span>
              </>
            )}
          </button>
        </div>
      </div>

      {resultMessage && (
        <div
          className={`flex items-center gap-1.5 p-2 rounded-lg text-xs font-mono ${
            resultMessage.includes('failed')
              ? 'bg-rose-950/40 border border-rose-800 text-rose-300'
              : 'bg-emerald-950/40 border border-emerald-800 text-emerald-300'
          }`}
        >
          {resultMessage.includes('failed') ? (
            <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
          )}
          <span className="truncate">{resultMessage}</span>
        </div>
      )}
    </div>
  );
};
