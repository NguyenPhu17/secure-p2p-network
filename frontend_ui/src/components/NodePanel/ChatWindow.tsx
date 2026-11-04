import React, { useState, useRef } from 'react';
import { Send, Paperclip, Lock, ShieldCheck, FileText, Sparkles, CheckCheck } from 'lucide-react';
import { useNodeStateStore } from '../../store/nodeStateStore';

interface ChatWindowProps {
  nodeId: 'node_a' | 'node_b';
  targetPeerId?: string;
}

export const ChatWindow: React.FC<ChatWindowProps> = ({
  nodeId,
  targetPeerId = 'node_b',
}) => {
  const {
    nodeA,
    nodeB,
    isSendingMessage,
    sendSecureMessage,
    sendSecureFile,
  } = useNodeStateStore();

  const currentNode = nodeId === 'node_a' ? nodeA : nodeB;
  const messages = currentNode.messages;
  const hasSession = currentNode.sessions.some((s) => s.peer_id === targetPeerId);

  const [inputVal, setInputVal] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputVal.trim() || isSendingMessage) return;

    const text = inputVal.trim();
    setInputVal('');
    try {
      await sendSecureMessage(nodeId, targetPeerId, text);
    } catch (err: any) {
      alert(`Error sending secure message: ${err.message}`);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      // Extract pure base64
      const base64Content = dataUrl.split(',')[1] || dataUrl;

      try {
        await sendSecureFile(
          nodeId,
          targetPeerId,
          file.name,
          base64Content,
          file.type || 'application/octet-stream'
        );
      } catch (err: any) {
        alert(`Error sending file: ${err.message}`);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const setPreset = (presetText: string) => {
    setInputVal(presetText);
  };

  return (
    <div className="flex flex-col h-full bg-slate-950/60 border border-slate-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-2 bg-slate-900/80 border-b border-slate-800 text-xs">
        <div className="flex items-center gap-1.5 text-slate-300 font-medium">
          <Lock className="w-3.5 h-3.5 text-cyan-400" />
          <span>Encrypted Channel ({nodeId} → {targetPeerId})</span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-slate-400 font-mono">
          <ShieldCheck className="w-3 h-3 text-emerald-400" />
          <span>AES-256-GCM + RSA-PSS</span>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 p-3 overflow-y-auto space-y-2.5 min-h-[160px] max-h-[220px]">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-slate-500 text-xs">
            <Lock className="w-6 h-6 mb-1 text-slate-600" />
            <p>Chưa có tin nhắn nào.</p>
            <p className="text-[11px] text-slate-600 mt-0.5">
              Tất cả tin nhắn được mã hóa đối xứng AES-256 và ký số RSA-PSS.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.direction === 'SENT';
            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs shadow-md ${
                    isMe
                      ? 'bg-linear-to-r from-blue-600 to-indigo-600 text-white rounded-br-xs'
                      : 'bg-slate-800/90 text-slate-100 border border-slate-700/60 rounded-bl-xs'
                  }`}
                >
                  {msg.type === 'file' ? (
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-amber-300 shrink-0" />
                      <div>
                        <p className="font-semibold text-xs">{msg.filename}</p>
                        <p className="text-[10px] opacity-80">{msg.size_bytes} bytes · Verified</p>
                      </div>
                    </div>
                  ) : (
                    <p className="break-words leading-relaxed">{msg.content}</p>
                  )}

                  <div
                    className={`flex items-center justify-end gap-1 mt-1 text-[10px] ${
                      isMe ? 'text-blue-200' : 'text-slate-400'
                    }`}
                  >
                    <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <CheckCheck className="w-3 h-3 text-cyan-300" />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Quick Test Presets */}
      <div className="px-3 py-1 bg-slate-900/50 border-t border-slate-800/60 flex items-center gap-1.5 overflow-x-auto text-[11px]">
        <span className="text-slate-500 shrink-0 flex items-center gap-0.5">
          <Sparkles className="w-2.5 h-2.5 text-amber-400" />
          Preset:
        </span>
        <button
          onClick={() => setPreset('Kế hoạch phân tán: Tấn công MITM được phát hiện tức thì tại Node B.')}
          className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 truncate transition active:scale-95"
        >
          Kế hoạch P2P
        </button>
        <button
          onClick={() => setPreset('Chuyển khoản bí mật: 50,000 USD tới tài khoản 987654321.')}
          className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 truncate transition active:scale-95"
        >
          Giao dịch ngân hàng
        </button>
        <button
          onClick={() => setPreset('Khóa phiên K_AB: Toàn vẹn thông qua AES-GCM 16-byte Auth Tag.')}
          className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 truncate transition active:scale-95"
        >
          Cryptographic Test
        </button>
      </div>

      {/* Input Form */}
      <form onSubmit={handleSend} className="p-2.5 bg-slate-900/90 border-t border-slate-800 flex items-center gap-2">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!hasSession || isSendingMessage}
          className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition disabled:opacity-40"
          title="Send Encrypted File"
        >
          <Paperclip className="w-4 h-4" />
        </button>

        <input
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          placeholder={
            hasSession
              ? `Nhập tin nhắn bảo mật tới ${targetPeerId}...`
              : 'Hãy bắt tay (Handshake) trước để thiết lập khóa...'
          }
          disabled={!hasSession || isSendingMessage}
          className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-hidden focus:border-cyan-500 transition disabled:opacity-50"
        />

        <button
          type="submit"
          disabled={!hasSession || !inputVal.trim() || isSendingMessage}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-linear-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white text-xs font-medium shadow-md shadow-cyan-500/20 active:scale-95 transition disabled:opacity-40"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Gửi</span>
        </button>
      </form>
    </div>
  );
};

