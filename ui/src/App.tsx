import React, { useState, useEffect } from "react";
import { usePeerSocket } from "./hooks/usePeerSocket";
import { LoginModal } from "./components/LoginModal";
import { Sidebar } from "./components/Sidebar";
import { ChatArea } from "./components/ChatArea";
import { ProtocolLogs } from "./components/ProtocolLogs";
import { StatusBar } from "./components/StatusBar";
import { AlertBanner } from "./components/AlertBanner";

export const App: React.FC = () => {
  // Lấy cổng từ URL query param (ví dụ ?port=3001) hoặc mặc định 3001
  const searchParams = new URLSearchParams(window.location.search);
  const paramPort = searchParams.get("port") ? parseInt(searchParams.get("port")!, 10) : null;

  const [wsPort, setWsPort] = useState<number | null>(paramPort);
  // Mở sẵn Protocol Logs mặc định để tối ưu không gian 3 cột phục vụ demo/thuyết trình
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

  // Khi chọn một peer, tự động tải lịch sử tin nhắn
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
          // Cập nhật URL không reload
          window.history.replaceState({}, "", `?port=${port}`);
        }}
      />
    );
  }

  const activePeerInfo = peers.find((p) => p.displayName === activePeer);
  const isPeerOnline = !!activePeerInfo;

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-slate-50 font-sans">
      {/* Banner cảnh báo lỗi nếu có */}
      <AlertBanner message={errorAlert} onClose={clearAlert} />

      {/* Vùng làm việc chính 3 cột */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Cột 1: Danh sách Peer */}
        <Sidebar
          me={me}
          tcpPort={tcpPort}
          peers={peers}
          activePeer={activePeer}
          onSelectPeer={(name) => setActivePeer(name)}
        />

        {/* Cột 2: Khung Chat & Gửi file */}
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

        {/* Cột 3: Protocol Logs Panel (Luôn mở mặc định) */}
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

      {/* Thanh trạng thái dưới đáy */}
      <StatusBar
        channelStatus={channelStatus}
        tcpPort={tcpPort}
        onlineCount={peers.length}
      />
    </div>
  );
};

export default App;
