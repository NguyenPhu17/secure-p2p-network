import { useState, useEffect } from 'react';
import { Shield, Radio, Key, Network, Server, AlertTriangle, CheckCircle, RefreshCw, Layers } from 'lucide-react';

interface ServiceStatus {
  id: string;
  name: string;
  url: string;
  port: number;
  status: 'checking' | 'healthy' | 'offline';
  data?: any;
}

export default function App() {
  const [services, setServices] = useState<Record<string, ServiceStatus>>({
    ca_server: { id: 'ca_server', name: 'CA / KDC Server (PKI Root)', url: 'http://localhost:8000/health', port: 8000, status: 'checking' },
    mitm_proxy: { id: 'mitm_proxy', name: 'MITM Intercept Proxy', url: 'http://localhost:8080/health', port: 8080, status: 'checking' },
    peer_a: { id: 'peer_a', name: 'Peer Node A (Sender)', url: 'http://localhost:8001/health', port: 8001, status: 'checking' },
    peer_b: { id: 'peer_b', name: 'Peer Node B (Receiver)', url: 'http://localhost:8002/health', port: 8002, status: 'checking' },
    peer_c: { id: 'peer_c', name: 'Peer Node C (Observer)', url: 'http://localhost:8003/health', port: 8003, status: 'checking' },
  });

  const [refreshing, setRefreshing] = useState(false);

  const checkHealth = async () => {
    setRefreshing(true);
    const updated = { ...services };

    for (const key of Object.keys(updated)) {
      try {
        const res = await fetch(updated[key].url);
        if (res.ok) {
          const json = await res.json();
          updated[key] = { ...updated[key], status: 'healthy', data: json };
        } else {
          updated[key] = { ...updated[key], status: 'offline', data: null };
        }
      } catch (err) {
        updated[key] = { ...updated[key], status: 'offline', data: null };
      }
    }

    setServices(updated);
    setRefreshing(false);
  };

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-black">
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-linear-to-tr from-cyan-500 to-blue-600 p-2.5 rounded-xl shadow-lg shadow-cyan-500/20">
            <Shield className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight bg-linear-to-r from-cyan-400 via-sky-300 to-blue-400 bg-clip-text text-transparent">
              Secure P2P Network Monitor
            </h1>
            <p className="text-xs text-slate-400">
              Distributed Systems · van Steen & Tanenbaum (§9.1–9.3) · Phase 0: Scaffolding
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-2 bg-slate-800/80 border border-slate-700/60 rounded-lg px-3 py-1.5 text-xs">
            <span className="text-slate-400">Network:</span>
            <span className="font-mono text-cyan-400">bridge: p2p-secure-net</span>
          </div>

          <button
            onClick={checkHealth}
            disabled={refreshing}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 active:scale-95 transition border border-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin text-cyan-400' : ''}`} />
            <span>Health Check</span>
          </button>
        </div>
      </header>

      {/* Main 3-Column Layout */}
      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Column 1: Peer Node A (Sender) */}
        <section className="lg:col-span-4 flex flex-col gap-4">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl flex-1 flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-blue-500/10 border border-blue-500/20 rounded-lg text-blue-400">
                  <Radio className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-semibold text-sm text-slate-200">Peer Node A (Sender)</h2>
                  <span className="text-xs font-mono text-slate-500">Port 8001 · node_a</span>
                </div>
              </div>
              <StatusBadge status={services.peer_a.status} />
            </div>

            <div className="mt-4 space-y-3 flex-1">
              <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl">
                <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                  <Key className="w-3.5 h-3.5 text-cyan-400" />
                  <span>PKI Identity & Certificate</span>
                </div>
                <p className="text-xs font-mono text-slate-300">
                  {services.peer_a.status === 'healthy' ? 'Online (Awaiting Phase 1 Registration)' : 'Node offline'}
                </p>
              </div>

              <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl">
                <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                  <Layers className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Session Key (AES-256-GCM)</span>
                </div>
                <p className="text-xs font-mono text-slate-500 italic">No active session</p>
              </div>

              <div className="p-4 border border-dashed border-slate-800 rounded-xl text-center text-xs text-slate-500">
                Peer Node Servant ready for Phase 2 Handshake & Message Transmission
              </div>
            </div>
          </div>
        </section>

        {/* Column 2: MITM Proxy & Intercept Engine */}
        <section className="lg:col-span-4 flex flex-col gap-4">
          <div className="bg-slate-900/90 border border-amber-950/40 rounded-2xl p-5 shadow-xl flex-1 flex flex-col ring-1 ring-amber-500/20">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400">
                  <Network className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-semibold text-sm text-slate-200">MITM Proxy & Inspector</h2>
                  <span className="text-xs font-mono text-slate-500">Port 8080 · Reverse Relay</span>
                </div>
              </div>
              <StatusBadge status={services.mitm_proxy.status} />
            </div>

            <div className="mt-4 space-y-3 flex-1">
              <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-slate-400">Relay Mode:</span>
                  <span className="font-mono text-emerald-400 font-semibold uppercase">Passthrough</span>
                </div>
                <p className="text-xs text-slate-500">
                  Ready to capture traffic and simulate: Tamper, Replay, Spoof.
                </p>
              </div>

              <div className="p-4 border border-dashed border-amber-900/40 bg-amber-950/10 rounded-xl text-center text-xs text-amber-300/80">
                <AlertTriangle className="w-4 h-4 mx-auto mb-1 text-amber-400" />
                MITM Interceptor scaffolded · Attacks configured in Phase 3
              </div>

              {/* Central CA Root Quick Status */}
              <div className="p-3 bg-slate-950/80 border border-cyan-900/30 rounded-xl">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-medium text-slate-300">CA / KDC Server</span>
                  </div>
                  <StatusBadge status={services.ca_server.status} />
                </div>
                <p className="text-[11px] text-slate-500 mt-1 font-mono">Port 8000 · PKI Certificate Authority</p>
              </div>
            </div>
          </div>
        </section>

        {/* Column 3: Peer Node B (Receiver) */}
        <section className="lg:col-span-4 flex flex-col gap-4">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl flex-1 flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400">
                  <Radio className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-semibold text-sm text-slate-200">Peer Node B (Receiver)</h2>
                  <span className="text-xs font-mono text-slate-500">Port 8002 · node_b</span>
                </div>
              </div>
              <StatusBadge status={services.peer_b.status} />
            </div>

            <div className="mt-4 space-y-3 flex-1">
              <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl">
                <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                  <Key className="w-3.5 h-3.5 text-emerald-400" />
                  <span>PKI Identity & Certificate</span>
                </div>
                <p className="text-xs font-mono text-slate-300">
                  {services.peer_b.status === 'healthy' ? 'Online (Awaiting Phase 1 Registration)' : 'Node offline'}
                </p>
              </div>

              <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl">
                <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                  <CheckCircle className="w-3.5 h-3.5 text-slate-500" />
                  <span>Decryption & 3-Tier Verification Log</span>
                </div>
                <p className="text-xs font-mono text-slate-500 italic">No incoming payload verified yet</p>
              </div>

              <div className="p-4 border border-dashed border-slate-800 rounded-xl text-center text-xs text-slate-500">
                Receiver ready with Anti-replay, GCM Tag, & RSA Signature verification
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-900/60 px-6 py-3 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-2">
        <div className="flex items-center gap-4">
          <span>Distributed Systems Coursework</span>
          <span>•</span>
          <span>Docker Bridge: <code className="text-slate-400">p2p-secure-net</code></span>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-cyan-500 animate-pulse"></span>
          <span>Phase 0 Initialized Successfully</span>
        </div>
      </footer>
    </div>
  );
}

function StatusBadge({ status }: { status: 'checking' | 'healthy' | 'offline' }) {
  if (status === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
        Online
      </span>
    );
  }

  if (status === 'checking') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
        Connecting
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/30">
      <span className="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
      Offline
    </span>
  );
}
