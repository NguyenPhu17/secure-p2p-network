import React from 'react';
import {
  Radio,
  ShieldCheck,
  ShieldAlert,
  RotateCcw,
} from 'lucide-react';
import { useNodeStateStore } from '../../store/nodeStateStore';
import { StatusLight } from '../shared/StatusLight';
import { KeyStatusCard } from './KeyStatusCard';
import { HandshakeControl } from './HandshakeControl';
import { ChatWindow } from './ChatWindow';
import { DecryptionLog } from './DecryptionLog';
import { ReceivedContent } from './ReceivedContent';

interface NodePanelProps {
  nodeId: 'node_a' | 'node_b';
  role: 'sender' | 'receiver';
  port: number;
}

export const NodePanel: React.FC<NodePanelProps> = ({ nodeId, role, port }) => {
  const { nodeA, nodeB, clearSecurityAlert } = useNodeStateStore();
  const currentNode = nodeId === 'node_a' ? nodeA : nodeB;
  const isSender = role === 'sender';
  const isAlert = currentNode.securityStatus === 'ALERT';

  return (
    <section className="flex flex-col gap-4">
      <div
        className={`bg-slate-900/90 border rounded-2xl p-4 shadow-xl flex-1 flex flex-col space-y-4 transition duration-300 ${
          isAlert
            ? 'border-rose-600/80 ring-2 ring-rose-500/30'
            : isSender
            ? 'border-blue-900/40 ring-1 ring-blue-500/20'
            : 'border-emerald-900/40 ring-1 ring-emerald-500/20'
        }`}
      >
        {/* Panel Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div
              className={`p-2 rounded-xl ${
                isSender
                  ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400'
                  : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
              }`}
            >
              <Radio className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-sm text-slate-100">
                  {isSender ? 'Cột 1: Peer Node A (Sender)' : 'Cột 3: Peer Node B (Receiver)'}
                </h2>
                <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                  Port {port}
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono">
                {currentNode.id} · {isSender ? 'Servant Initiator' : 'Servant Receiver'}
              </p>
            </div>
          </div>

          <StatusLight
            status={currentNode.isOnline ? (isAlert ? 'alert' : 'healthy') : 'offline'}
            label={currentNode.isOnline ? (isAlert ? 'Cảnh báo Đỏ' : 'Online') : 'Offline'}
          />
        </div>

        {/* Receiver Large Security Status Light Banner */}
        {!isSender && (
          <div
            className={`p-3.5 rounded-xl border flex items-center justify-between transition duration-300 ${
              isAlert
                ? 'bg-rose-950/60 border-rose-600 text-rose-200 ring-1 ring-rose-500/40 animate-pulse'
                : 'bg-emerald-950/30 border-emerald-800/60 text-emerald-300'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <div
                className={`p-2 rounded-xl shrink-0 ${
                  isAlert ? 'bg-rose-600 text-white animate-bounce' : 'bg-emerald-500/20 text-emerald-400'
                }`}
              >
                {isAlert ? <ShieldAlert className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
              </div>
              <div>
                <h3 className="font-bold text-xs uppercase tracking-wider">
                  {isAlert ? '🔴 Cảnh báo Phát hiện Tấn công Mạng!' : '🟢 Trạng thái Bảo mật: An toàn & Toàn vẹn'}
                </h3>
                <p className="text-[11px] opacity-90 mt-0.5">
                  {isAlert
                    ? currentNode.latestAlert?.detail || 'Gói tin vi phạm kiểm tra toàn vẹn hoặc phát lại'
                    : 'AES-256-GCM Tag hợp lệ · Chữ ký RSA-PSS khớp · Nonce hợp lệ'}
                </p>
              </div>
            </div>

            {isAlert && (
              <button
                onClick={() => clearSecurityAlert(nodeId)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-900/80 hover:bg-rose-800 text-white text-xs font-semibold shrink-0 transition active:scale-95 border border-rose-500/40"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Đặt lại</span>
              </button>
            )}
          </div>
        )}

        {/* 1. Identity & Keys Card */}
        <KeyStatusCard
          nodeId={currentNode.id}
          identity={currentNode.identity}
          sessions={currentNode.sessions}
          authenticatedPeers={currentNode.authenticatedPeers}
        />

        {/* 2. Sender Handshake Trigger & Chat Interface */}
        {isSender && (
          <>
            <HandshakeControl nodeId={nodeId} />
            <div className="flex-1">
              <ChatWindow nodeId={nodeId} targetPeerId="node_b" />
            </div>
          </>
        )}

        {/* 3. Receiver Verification Logs & Decrypted Data */}
        {!isSender && (
          <>
            <DecryptionLog logs={currentNode.decryptionLogs} />
            <ReceivedContent messages={currentNode.messages} />
            {/* Can also reply back to Node A */}
            <div className="pt-2 border-t border-slate-800/80">
              <ChatWindow nodeId={nodeId} targetPeerId="node_a" />
            </div>
          </>
        )}
      </div>
    </section>
  );
};
