import React from 'react';
import { ShieldCheck, ShieldAlert, Key, Award, Lock } from 'lucide-react';
import type { IdentityInfo, SessionInfo } from '../../types/protocol';
import { KeyFingerprint } from '../shared/KeyFingerprint';

interface KeyStatusCardProps {
  nodeId: string;
  identity: IdentityInfo | null;
  sessions: SessionInfo[];
  authenticatedPeers: string[];
}

export const KeyStatusCard: React.FC<KeyStatusCardProps> = ({
  identity,
  sessions,
}) => {
  const isRegistered = identity?.is_registered ?? false;
  const cert = identity?.certificate;
  const activeSession = sessions.length > 0 ? sessions[0] : null;

  return (
    <div className="space-y-2.5">
      {/* PKI Certificate Info */}
      <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-slate-300 font-medium">
            <Award className="w-3.5 h-3.5 text-cyan-400" />
            <span>X.509 Digital Certificate (§9.2.4)</span>
          </div>
          {isRegistered ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              <ShieldCheck className="w-3 h-3" />
              CA Verified
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/30">
              <ShieldAlert className="w-3 h-3" />
              Unregistered
            </span>
          )}
        </div>

        {cert ? (
          <div className="grid grid-cols-2 gap-2 text-[11px] font-mono text-slate-400 pt-1 border-t border-slate-800/60">
            <div>
              <span className="text-slate-500 font-sans">Issuer: </span>
              <span className="text-slate-200">{cert.issuer}</span>
            </div>
            <div>
              <span className="text-slate-500 font-sans">Subject: </span>
              <span className="text-slate-200">{cert.subject}</span>
            </div>
            <div>
              <span className="text-slate-500 font-sans">Serial: </span>
              <span className="text-cyan-400">{cert.serial_number}</span>
            </div>
            <div>
              <span className="text-slate-500 font-sans">Valid: </span>
              <span className="text-emerald-400">30 days</span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500 italic">Awaiting CA certificate registration...</p>
        )}

        {/* Public Key Fingerprint */}
        <KeyFingerprint
          label="RSA-2048 PK"
          fingerprint={identity?.public_key_fingerprint}
          pemContent={identity?.public_key_pem}
          type="RSA_PUBLIC"
        />

        {identity?.certificate_pem && (
          <KeyFingerprint
            label="X.509 Cert"
            fingerprint={cert?.serial_number}
            pemContent={identity.certificate_pem}
            type="CERTIFICATE"
          />
        )}
      </div>

      {/* Symmetric Session Key Info */}
      <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-slate-300 font-medium">
            <Lock className="w-3.5 h-3.5 text-indigo-400" />
            <span>Active Session Key (AES-256-GCM — §9.2.1)</span>
          </div>
          {activeSession ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">
              <Key className="w-3 h-3" />
              Active
            </span>
          ) : (
            <span className="text-[11px] text-slate-500 italic">No Key Established</span>
          )}
        </div>

        {activeSession ? (
          <div className="space-y-1.5 pt-1 border-t border-slate-800/60 font-mono text-[11px]">
            <div className="flex justify-between items-center text-slate-400">
              <span className="font-sans text-slate-500">Session ID:</span>
              <span className="text-indigo-300 truncate max-w-[200px]" title={activeSession.session_id}>
                {activeSession.session_id.slice(0, 18)}...
              </span>
            </div>
            <div className="flex justify-between items-center text-slate-400">
              <span className="font-sans text-slate-500">Peer / Role:</span>
              <span className="text-slate-200">
                {activeSession.peer_id} · <span className="text-cyan-400">{activeSession.role}</span>
              </span>
            </div>
            <div className="flex justify-between items-center text-slate-400">
              <span className="font-sans text-slate-500">Transferred:</span>
              <span className="text-emerald-400 font-semibold">{activeSession.messages_count} payload(s)</span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500 italic">
            Run Mutual Handshake to exchange wrapped AES key.
          </p>
        )}
      </div>
    </div>
  );
};
