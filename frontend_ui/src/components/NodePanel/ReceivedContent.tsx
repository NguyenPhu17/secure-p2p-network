import React from 'react';
import { MessageSquare, FileDown, CheckCircle, ShieldCheck } from 'lucide-react';
import type { ChatMessage } from '../../types/protocol';

interface ReceivedContentProps {
  messages: ChatMessage[];
}

export const ReceivedContent: React.FC<ReceivedContentProps> = ({ messages }) => {
  const receivedOnly = messages.filter((m) => m.direction === 'RECEIVED');

  if (receivedOnly.length === 0) {
    return (
      <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl text-center text-xs text-slate-500">
        <MessageSquare className="w-5 h-5 mx-auto mb-1.5 text-slate-600" />
        <p>Hộp thư đến trống.</p>
        <p className="text-[11px] text-slate-600 mt-0.5">
          Tin nhắn & file sau khi vượt qua thẩm tra bảo mật sẽ hiển thị tại đây.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-300 font-medium">
        <div className="flex items-center gap-1.5">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
          <span>Dữ liệu Đã Giải mã & Lưu trữ ({receivedOnly.length})</span>
        </div>
        <span className="text-[11px] text-emerald-400 font-mono flex items-center gap-1">
          <ShieldCheck className="w-3 h-3" />
          Toàn vẹn xác minh
        </span>
      </div>

      <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
        {receivedOnly.map((msg) => (
          <div
            key={msg.id}
            className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl text-xs space-y-1.5 hover:border-slate-700 transition"
          >
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span className="font-semibold text-cyan-400 font-mono">
                Từ: {msg.from}
              </span>
              <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
            </div>

            {msg.type === 'file' ? (
              <div className="flex items-center justify-between p-2 bg-slate-900 border border-slate-800 rounded-lg">
                <div className="flex items-center gap-2 overflow-hidden mr-2">
                  <FileDown className="w-4 h-4 text-amber-400 shrink-0" />
                  <div className="truncate">
                    <p className="font-medium text-slate-200 truncate">{msg.filename}</p>
                    <p className="text-[10px] text-slate-400">{msg.size_bytes} bytes · File bảo mật</p>
                  </div>
                </div>
                <span className="text-[10px] text-emerald-400 font-mono bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30 shrink-0">
                  Đã lưu ổ đĩa
                </span>
              </div>
            ) : (
              <p className="text-slate-200 bg-slate-900/60 p-2 rounded-lg border border-slate-800/60 font-mono text-xs select-all">
                "{msg.content}"
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
