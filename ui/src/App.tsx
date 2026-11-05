import React, { useState, useEffect } from "react";
import { usePeerSocket } from "./hooks/usePeerSocket";
import { LoginModal } from "./components/LoginModal";
import { Sidebar } from "./components/Sidebar";
import { ChatArea } from "./components/ChatArea";
import { ProtocolLogs } from "./components/ProtocolLogs";
import { StatusBar } from "./components/StatusBar";
import { AlertBanner } from "./components/AlertBanner";

export const App: React.FC = () => {
  const searchParams = new URLSearchParams(window.location.search);
  const paramPort = searchParams.get("port") ? parseInt(searchParams.get("port")!, 10) : null;

  const [wsPort, setWsPort] = useState<number | null>(paramPort);
  const [isLogsOpen, setIsLogsOpen] = useState(true);

  const {
    connected,
    me,
    tcpPort,
    peers,
    activePeer,
    setActivePeer,
    messages,
    fileTransfers,
    logs,
    channelStatus,
    errorAlert,
    clearAlert,
    sendChat,
    sendFile,
    loadHistory,
    deleteHistory
  } = usePeerSocket(wsPort || 3001);

  useEffect(() => {
    if (activePeer) {
      loadHistory(activePeer);
    }
  }, [activePeer, loadHistory]);

  if (!wsPort || !connected) {
    return (
      <LoginModal
        defaultPort={wsPort || 3001}
        onConnect={(port) => {
          setWsPort(port);
          window.history.replaceState({}, "", `?port=${port}`);
        }}
      />
    );
  }

  const activePeerInfo = peers.find((p) => p.displayName === activePeer);
  const isPeerOnline = !!activePeerInfo;

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-white text-[#0F172A] font-sans antialiased">
      {/* Alert Banner if any */}
      <AlertBanner message={errorAlert} onClose={clearAlert} />

      {/* Main 3-column workbench */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Column 1: Peers List Sidebar */}
        <Sidebar
          me={me}
          tcpPort={tcpPort}
          peers={peers}
          activePeer={activePeer}
          onSelectPeer={(name) => setActivePeer(name)}
        />

        {/* Column 2: Chat & File Transfer Stream */}
        <ChatArea
          activePeer={activePeer}
          isPeerOnline={isPeerOnline}
          peerInfo={activePeerInfo}
          channelStatus={channelStatus}
          messages={messages}
          fileTransfers={fileTransfers}
          onSendMessage={(body) => activePeer && sendChat(activePeer, body)}
          onSendFile={(filePath) => activePeer && sendFile(activePeer, filePath)}
          onDeleteHistory={() => activePeer && deleteHistory(activePeer)}
        />

        {/* Column 3: TCP Protocol Inspector Panel */}
        <ProtocolLogs
          logs={logs}
          isOpen={isLogsOpen}
          onToggle={() => setIsLogsOpen(!isLogsOpen)}
          me={me}
          tcpPort={tcpPort}
          activePeer={activePeer}
          activePeerInfo={activePeerInfo}
          channelStatus={channelStatus}
        />
      </div>

      {/* Bottom Status Bar */}
      <StatusBar
        channelStatus={channelStatus}
        tcpPort={tcpPort}
        onlineCount={peers.length}
      />
    </div>
  );
};

export default App;
