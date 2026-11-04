import React from 'react';
import {
  FileCode,
  Shield,
  Key,
  Hash,
  AlertTriangle,
} from 'lucide-react';
import { usePacketStore } from '../../store/packetStore';
import { JsonViewer } from '../shared/JsonViewer';

export const PacketInspector: React.FC = () => {
  const { packets, selectedPacketId } = usePacketStore();
  const packet = packets.find((p) => p.packet_id === selectedPacketId) || packets[0];

  if (!packet) {
    return (
      <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl text-center text-xs text-slate-500">
        <FileCode className="w-5 h-5 mx-auto mb-1 text-slate-600" />
        <p>Chọn một gói tin từ danh sách để phân tích mật mã chi tiết.</p>
      </div>
    );
  }

  const raw = packet.raw_json || {};
  const payload = raw.payload || {};
  const integrity = raw.integrity || {};

  return (
    <div className="space-y-3">
      {/* Header bar */}
      <div className="flex items-center justify-between text-xs text-slate-300 font-medium">
        <div className="flex items-center gap-1.5">
          <FileCode className="w-3.5 h-3.5 text-cyan-400" />
          <span>Trình Soi Gói Tin (Packet Inspector — §9.1.1)</span>
        </div>
        <span className="font-mono text-[11px] text-cyan-400">
          ID: {packet.packet_id}
        </span>
      </div>

      {/* Attack Result Banner if packet was targeted */}
      {packet.attack_type && (
        <div className="p-3 bg-rose-950/40 border border-rose-900/80 rounded-xl space-y-1.5 text-xs text-rose-200">
          <div className="flex items-center gap-1.5 font-bold text-rose-400">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Kịch bản Tấn công: {packet.attack_type}</span>
          </div>
          {packet.attack_details && (
            <p className="font-mono text-[11px] text-rose-300">
              Chi tiết: {JSON.stringify(packet.attack_details)}
            </p>
          )}
          {packet.receiver_response && (
            <div className="mt-1 pt-1 border-t border-rose-900/40 text-[11px] font-mono">
              <span className="text-slate-400 font-sans">Node nhận phản hồi: </span>
              <span className="text-amber-300 font-bold">
                {packet.receiver_response.status || 'ERROR'} ({packet.receiver_response.error_code || '400'})
              </span>
              <p className="text-rose-300 italic mt-0.5">
                "{packet.receiver_response.detail || 'Từ chối nhận gói tin'}"
              </p>
            </div>
          )}
        </div>
      )}

      {/* Cryptographic Primitives Breakdown */}
      <div className="grid grid-cols-1 gap-2 text-xs">
        {/* Symmetric Encryption Breakdown */}
        {(payload.ciphertext || payload.ciphertext_b64) && (
          <div className="p-2.5 bg-slate-950/70 border border-indigo-950/60 rounded-xl space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-indigo-400 flex items-center gap-1">
                <Shield className="w-3 h-3" />
                Mật mã Đối xứng: AES-256-GCM (§9.2.1)
              </span>
              <span className="text-slate-500 font-mono">Confidentiality</span>
            </div>
            <div className="space-y-1 font-mono text-[11px] text-slate-400">
              <div className="truncate">
                <span className="text-slate-500 font-sans">Ciphertext: </span>
                <span className="text-indigo-300">
                  {payload.ciphertext || payload.ciphertext_b64}
                </span>
              </div>
              <div className="flex justify-between">
                <span>
                  <span className="text-slate-500 font-sans">IV: </span>
                  <span className="text-slate-300">{payload.iv} (12 bytes)</span>
                </span>
                <span>
                  <span className="text-slate-500 font-sans">Auth Tag: </span>
                  <span className="text-emerald-400 font-bold">{payload.tag} (16 bytes)</span>
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Digital Signature & Hash Breakdown */}
        {(integrity.hash || integrity.signature) && (
          <div className="p-2.5 bg-slate-950/70 border border-purple-950/60 rounded-xl space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-purple-400 flex items-center gap-1">
                <Hash className="w-3 h-3" />
                Toàn vẹn & Chữ ký số: SHA-256 + RSA-PSS (§9.2.3)
              </span>
              <span className="text-slate-500 font-mono">Non-repudiation</span>
            </div>
            <div className="space-y-1 font-mono text-[11px] text-slate-400">
              <div className="truncate">
                <span className="text-slate-500 font-sans">SHA-256 Digest: </span>
                <span className="text-cyan-300">{integrity.hash}</span>
              </div>
              <div className="truncate">
                <span className="text-slate-500 font-sans">RSA-PSS Sig: </span>
                <span className="text-purple-300">{integrity.signature}</span>
              </div>
            </div>
          </div>
        )}

        {/* Nonce & Certificate for Handshake */}
        {(raw.nonce_A || raw.nonce_B || raw.certificate_pem) && (
          <div className="p-2.5 bg-slate-950/70 border border-cyan-950/60 rounded-xl space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-cyan-400 flex items-center gap-1">
                <Key className="w-3 h-3" />
                Handshake Challenge-Response (§9.3.2)
              </span>
              <span className="text-slate-500 font-mono">Mutual Auth</span>
            </div>
            <div className="space-y-1 font-mono text-[11px] text-slate-400">
              {raw.nonce_A && (
                <div className="truncate">
                  <span className="text-slate-500 font-sans">Nonce A: </span>
                  <span className="text-amber-300">{raw.nonce_A} (32 bytes)</span>
                </div>
              )}
              {raw.nonce_B && (
                <div className="truncate">
                  <span className="text-slate-500 font-sans">Nonce B: </span>
                  <span className="text-amber-300">{raw.nonce_B} (32 bytes)</span>
                </div>
              )}
              {raw.certificate_pem && (
                <div className="truncate">
                  <span className="text-slate-500 font-sans">X.509 Cert: </span>
                  <span className="text-emerald-400">-----BEGIN CERTIFICATE-----...</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Raw JSON Structure */}
      <JsonViewer data={raw} maxHeight="max-h-56" />
    </div>
  );
};
