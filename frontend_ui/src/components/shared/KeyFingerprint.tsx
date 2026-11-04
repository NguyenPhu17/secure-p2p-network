import React, { useState } from 'react';
import { Key, Eye, Copy, Check } from 'lucide-react';
import { Modal } from './Modal';

interface KeyFingerprintProps {
  label: string;
  fingerprint?: string;
  pemContent?: string;
  type?: 'RSA_PUBLIC' | 'CERTIFICATE' | 'SESSION_KEY';
}

export const KeyFingerprint: React.FC<KeyFingerprintProps> = ({
  label,
  fingerprint,
  pemContent,
  type = 'RSA_PUBLIC',
}) => {
  const [showModal, setShowModal] = useState(false);
  const [copied, setCopied] = useState(false);

  const displayFp = fingerprint || (pemContent ? 'SHA256:' + pemContent.slice(28, 50) + '...' : 'None');

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(pemContent || displayFp);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <div className="flex items-center justify-between text-xs py-1 px-2.5 bg-slate-950/70 border border-slate-800/80 rounded-lg font-mono">
        <div className="flex items-center gap-2 overflow-hidden mr-2">
          <Key className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="text-slate-400 font-sans text-[11px] shrink-0">{label}:</span>
          <span className="text-cyan-300 truncate text-[11px]" title={displayFp}>
            {displayFp}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCopy}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition"
            title="Copy Key/Certificate"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          </button>
          {pemContent && (
            <button
              onClick={() => setShowModal(true)}
              className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition"
              title="View Raw PEM"
            >
              <Eye className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={type === 'CERTIFICATE' ? 'X.509 Public Certificate (PEM)' : 'RSA-2048 Public Key (PEM)'}
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Fingerprint: <code className="text-cyan-400">{fingerprint}</code></span>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? 'Copied' : 'Copy PEM'}</span>
            </button>
          </div>
          <pre className="p-4 bg-slate-950 border border-slate-800 rounded-xl font-mono text-xs text-emerald-400 overflow-x-auto whitespace-pre leading-relaxed select-all">
            {pemContent}
          </pre>
        </div>
      </Modal>
    </>
  );
};

