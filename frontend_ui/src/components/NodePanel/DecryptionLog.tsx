import React, { useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Layers,
  ChevronDown,
  ChevronRight,
  Clock,
  KeyRound,
  FileCheck2,
} from 'lucide-react';
import type { DecryptionLogEntry } from '../../types/protocol';

interface DecryptionLogProps {
  logs: DecryptionLogEntry[];
}

export const DecryptionLog: React.FC<DecryptionLogProps> = ({ logs }) => {
  const [expandedId, setExpandedId] = useState<string | null>(logs[0]?.id || null);

  if (logs.length === 0) {
    return (
      <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl text-center text-xs text-slate-500">
        <Layers className="w-5 h-5 mx-auto mb-1.5 text-slate-600" />
        <p>Chưa có gói tin nào được tiếp nhận và thẩm tra.</p>
        <p className="text-[11px] text-slate-600 mt-0.5">
          Quy trình thẩm tra 3 lớp (Lớp 1: Chống phát lại ➔ Lớp 2: Toàn vẹn GCM ➔ Lớp 3: Chữ ký RSA-PSS) sẽ xuất hiện tại đây.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-300 font-medium">
        <div className="flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-emerald-400" />
          <span>Nhật ký Thẩm tra 3 Lớp (Receiver Security Audit)</span>
        </div>
        <span className="text-[11px] text-slate-500 font-mono">
          {logs.length} bản ghi
        </span>
      </div>

      <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
        {logs.map((log) => {
          const isExpanded = expandedId === log.id;
          const isSuccess = log.status === 'SUCCESS';
          const v = log.verification;

          return (
            <div
              key={log.id}
              className={`border rounded-xl transition overflow-hidden text-xs ${
                isSuccess
                  ? 'bg-slate-950/70 border-emerald-950/50 hover:border-emerald-800/60'
                  : 'bg-rose-950/20 border-rose-900/60 hover:border-rose-700'
              }`}
            >
              {/* Header bar */}
              <div
                onClick={() => setExpandedId(isExpanded ? null : log.id)}
                className="flex items-center justify-between p-3 cursor-pointer select-none"
              >
                <div className="flex items-center gap-2 overflow-hidden mr-2">
                  {isSuccess ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-rose-500 shrink-0 animate-pulse" />
                  )}
                  <div className="truncate">
                    <span className="font-semibold text-slate-200">
                      {isSuccess ? 'Giải mã & Xác thực thành công' : `Cảnh báo: ${log.error_code || 'Lỗi toàn vẹn'}`}
                    </span>
                    <p className="text-[10px] text-slate-400 truncate">
                      {log.type} từ <code className="text-cyan-300">{log.from}</code> · {new Date(log.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${
                      isSuccess
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                    }`}
                  >
                    {isSuccess ? 'PASS 3/3' : 'ALERT'}
                  </span>
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </div>
              </div>

              {/* 3-Tier Step by Step Inspection */}
              {isExpanded && (
                <div className="p-3 pt-0 border-t border-slate-800/80 bg-slate-900/40 space-y-2.5">
                  {log.detail && (
                    <div className="p-2 bg-rose-950/40 border border-rose-800/80 rounded-lg text-[11px] text-rose-200 flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                      <span>{log.detail}</span>
                    </div>
                  )}

                  {log.plaintext && (
                    <div className="p-2 bg-slate-950/80 border border-slate-800 rounded-lg">
                      <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">
                        Plaintext Đã Giải Mã:
                      </span>
                      <p className="font-mono text-xs text-emerald-300 mt-0.5 select-all">
                        "{log.plaintext}"
                      </p>
                    </div>
                  )}

                  {/* The 3 Tiers */}
                  <div className="space-y-1.5 pt-1">
                    {/* Layer 1: Anti-Replay */}
                    <TierRow
                      tierNumber={1}
                      title="Lớp 1: Chống phát lại (Anti-Replay)"
                      subtitle="Timestamp trong khung 60s & Nonce / Message ID chưa từng xuất hiện (§9.3.2)"
                      status={v.layer1_replay}
                      icon={<Clock className="w-3.5 h-3.5 text-cyan-400" />}
                    />

                    {/* Layer 2: GCM Tag */}
                    <TierRow
                      tierNumber={2}
                      title="Lớp 2: Kiểm tra toàn vẹn đối xứng (AES-256-GCM Auth Tag)"
                      subtitle="Khớp 16-byte Auth Tag qua khóa phiên K_AB — phát hiện sửa bit (Tamper) (§9.2.1)"
                      status={v.layer2_gcm}
                      icon={<KeyRound className="w-3.5 h-3.5 text-indigo-400" />}
                    />

                    {/* Layer 3: RSA-PSS Signature */}
                    <TierRow
                      tierNumber={3}
                      title="Lớp 3: Xác thực nguồn gốc & Chống chối bỏ (RSA-PSS Signature)"
                      subtitle="Đối chiếu SHA-256 digest với chữ ký số của người gửi bằng Public Key (§9.2.3)"
                      status={v.layer3_signature}
                      icon={<FileCheck2 className="w-3.5 h-3.5 text-purple-400" />}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

interface TierRowProps {
  tierNumber: number;
  title: string;
  subtitle: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'PENDING';
  icon: React.ReactNode;
}

const TierRow: React.FC<TierRowProps> = ({ title, subtitle, status, icon }) => {
  const isPassed = status === 'PASSED';
  const isFailed = status === 'FAILED';

  let badgeColor = 'bg-slate-800 text-slate-400 border-slate-700';
  let badgeText = 'SKIPPED';
  if (isPassed) {
    badgeColor = 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    badgeText = 'PASSED ✓';
  } else if (isFailed) {
    badgeColor = 'bg-rose-500/25 text-rose-300 border-rose-500/50 font-bold';
    badgeText = 'FAILED ✗';
  }

  return (
    <div className="flex items-center justify-between p-2 rounded-lg bg-slate-950/50 border border-slate-800/80">
      <div className="flex items-start gap-2 mr-2">
        <div className="p-1 rounded bg-slate-900 border border-slate-800 shrink-0 mt-0.5">
          {icon}
        </div>
        <div>
          <h4 className="font-semibold text-slate-200 text-xs">{title}</h4>
          <p className="text-[10px] text-slate-400 leading-tight">{subtitle}</p>
        </div>
      </div>
      <span className={`px-2 py-0.5 rounded text-[10px] font-mono shrink-0 border ${badgeColor}`}>
        {badgeText}
      </span>
    </div>
  );
};
