import { usePacketStream } from './hooks/usePacketStream';
import { useNodeState } from './hooks/useNodeState';
import { Header } from './components/Header';
import { ScenarioBar } from './components/ScenarioBar';
import { NodePanel } from './components/NodePanel/NodePanel';
import { MitmPanel } from './components/MitmPanel/MitmPanel';

export default function App() {
  // Activate live WebSocket event streams
  usePacketStream();
  useNodeState();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-black">
      {/* 1. Top Navigation & System Health */}
      <Header />

      {/* 2. 1-Click Defense & Attack Scenarios */}
      <ScenarioBar />

      {/* 3. Main 3-Column Dashboard Layout */}
      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Column 1: Peer Node A (Sender) - lg:col-span-4 */}
        <div className="lg:col-span-4 flex flex-col">
          <NodePanel nodeId="node_a" role="sender" port={8001} />
        </div>

        {/* Column 2: MITM Proxy & Inspector - lg:col-span-4 */}
        <div className="lg:col-span-4 flex flex-col">
          <MitmPanel />
        </div>

        {/* Column 3: Peer Node B (Receiver) - lg:col-span-4 */}
        <div className="lg:col-span-4 flex flex-col">
          <NodePanel nodeId="node_b" role="receiver" port={8002} />
        </div>
      </main>

      {/* 4. Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-900/60 px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-semibold text-slate-400">Đồ án Hệ Thống Phân Tán</span>
          <span>•</span>
          <span>Giáo trình: <cite className="text-slate-300">Distributed Systems 4th Ed. — van Steen & Tanenbaum (§9.1–9.3)</cite></span>
          <span>•</span>
          <span>Docker Bridge: <code className="text-cyan-400">p2p-secure-net</code></span>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span className="text-slate-400 font-mono text-[11px]">Phase 4 Completed · All Modules Synchronized</span>
        </div>
      </footer>
    </div>
  );
}
