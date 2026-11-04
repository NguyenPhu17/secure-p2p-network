import React, { useState } from "react";
import { Terminal, ArrowRight, Server, Layers } from "lucide-react";

interface LoginModalProps {
  onConnect: (wsPort: number) => void;
  defaultPort?: number;
}

export const LoginModal: React.FC<LoginModalProps> = ({ onConnect, defaultPort = 3001 }) => {
  const [port, setPort] = useState(defaultPort.toString());

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseInt(port, 10);
    if (!isNaN(p) && p > 0) {
      onConnect(p);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-6 select-none bg-tech-dots">
      <div className="bg-white border border-slate-300 rounded-lg max-w-md w-full p-6 space-y-5 shadow-sm">
        {/* Logo / Title */}
        <div className="space-y-1.5 pb-4 border-b border-slate-200">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-md bg-slate-900 text-white flex items-center justify-center">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 font-mono tracking-tight uppercase">
                P2P Network Workbench
              </h2>
              <p className="text-xs text-slate-500 font-sans">
                Công cụ Kiểm thử Giao thức Mạng P2P & Giám sát Gói tin TCP
              </p>
            </div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-mono font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              WebSocket Peer Backend Port (Localhost)
            </label>
            <div className="relative">
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="3001"
                required
                className="w-full bg-slate-50 border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-slate-500 focus:bg-white transition-all"
              />
              <span className="absolute right-3 top-2.5 text-xs font-mono text-slate-400">
                ws://127.0.0.1
              </span>
            </div>
            <div className="mt-2 text-[11px] font-mono text-slate-500 flex flex-wrap gap-2">
              <span className="bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">
                Node Alice: 3001
              </span>
              <span className="bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">
                Node Bob: 3002
              </span>
              <span className="bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">
                Node Charlie: 3003
              </span>
            </div>
          </div>

          <button
            type="submit"
            className="w-full bg-slate-900 hover:bg-slate-800 text-white font-mono font-medium py-2.5 px-4 rounded-md text-xs transition-all flex items-center justify-center space-x-2"
          >
            <span>CONNECT TO PEER BACKEND</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </form>

        <div className="border-t border-slate-200 pt-3 flex items-center justify-between text-[11px] font-mono text-slate-500">
          <span className="flex items-center gap-1">
            <Server className="w-3 h-3 text-slate-400" />
            TCP Socket Direct
          </span>
          <span className="flex items-center gap-1">
            <Layers className="w-3 h-3 text-slate-400" />
            Packet Inspector
          </span>
        </div>
      </div>
    </div>
  );
};
