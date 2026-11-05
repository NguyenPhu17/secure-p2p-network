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
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col items-center justify-center p-6 select-none">
      <div className="bg-white border border-[#E2E8F0] rounded-[8px] max-w-md w-full p-6 space-y-5">
        {/* Logo / Title */}
        <div className="space-y-1.5 pb-4 border-b border-[#E2E8F0]">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 rounded-[4px] bg-[#0F172A] text-white flex items-center justify-center">
              <Terminal className="w-3.5 h-3.5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-[#0F172A] font-mono tracking-tight uppercase">
                P2P Network Workbench
              </h2>
              <p className="text-xs text-[#64748B] font-sans">
                Công cụ Kiểm thử Giao thức Mạng P2P & Giám sát Gói tin TCP
              </p>
            </div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-mono font-semibold uppercase tracking-wider text-[#0F172A] mb-1.5">
              WebSocket Peer Backend Port (Localhost)
            </label>
            <div className="relative">
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="3001"
                required
                className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] px-3 py-2 text-sm text-[#0F172A] font-mono focus:outline-none focus:border-[#0F172A] focus:bg-white transition-colors"
              />
              <span className="absolute right-3 top-2.5 text-xs font-mono text-[#94A3B8]">
                ws://127.0.0.1
              </span>
            </div>
            <div className="mt-2 text-[11px] font-mono text-[#64748B] flex flex-wrap gap-2">
              <span className="bg-[#F1F5F9] border border-[#E2E8F0] px-1.5 py-0.5 rounded-[3px]">
                Node Alice: 3001
              </span>
              <span className="bg-[#F1F5F9] border border-[#E2E8F0] px-1.5 py-0.5 rounded-[3px]">
                Node Bob: 3002
              </span>
              <span className="bg-[#F1F5F9] border border-[#E2E8F0] px-1.5 py-0.5 rounded-[3px]">
                Node Charlie: 3003
              </span>
            </div>
          </div>

          <button
            type="submit"
            className="w-full bg-[#0F172A] hover:bg-[#1E293B] text-white font-mono font-medium py-2.5 px-4 rounded-[4px] text-xs transition-colors flex items-center justify-center space-x-2"
          >
            <span>CONNECT TO PEER BACKEND</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </form>

        <div className="border-t border-[#E2E8F0] pt-3 flex items-center justify-between text-[11px] font-mono text-[#64748B]">
          <span className="flex items-center gap-1">
            <Server className="w-3 h-3 text-[#94A3B8]" />
            TCP Socket Direct
          </span>
          <span className="flex items-center gap-1">
            <Layers className="w-3 h-3 text-[#94A3B8]" />
            Packet Inspector
          </span>
        </div>
      </div>
    </div>
  );
};
