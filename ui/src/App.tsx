import React, { useState, useEffect } from "react";
import { usePeerSocket } from "./hooks/usePeerSocket";
import { LoginModal } from "./components/LoginModal";
import { Sidebar } from "./components/Sidebar";
import { ChatArea } from "./components/ChatArea";
import { ProtocolLogs } from "./components/ProtocolLogs";
import { StatusBar } from "./components/StatusBar";
import { AlertBanner } from "./components/AlertBanner";
import { AuthUser, apiVerifyToken } from "./utils/authApi";

export const App: React.FC = () => {
  const searchParams = new URLSearchParams(window.location.search);
  const paramPort = searchParams.get("port") ? parseInt(searchParams.get("port")!, 10) : null;

  // Khôi phục user từ sessionStorage (hoặc localStorage) nếu có
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => {
    try {
      const saved = sessionStorage.getItem("p2p_current_user") || localStorage.getItem("p2p_current_user");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [wsPort, setWsPort] = useState<number | null>(() => {
    if (paramPort) return paramPort;
    try {
      const saved = sessionStorage.getItem("p2p_current_user") || localStorage.getItem("p2p_current_user");
      if (saved) {
        const u: AuthUser = JSON.parse(saved);
        return u.nodePort;
      }
    } catch {}
    return null;
  });

  const [isLogsOpen, setIsLogsOpen] = useState(true);

  const {
    connected,
    me,
    tcpPort,
    peers,
    knownPeers,
    blockedPeers,
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
    deleteHistory,
    toggleFirewallBlock
  } = usePeerSocket(wsPort || 3001, currentUser?.username);

  // Kiểm tra tính hợp lệ của JWT Token khi tải ứng dụng
  useEffect(() => {
    const token = sessionStorage.getItem("p2p_auth_token") || localStorage.getItem("p2p_auth_token");
    if (token && currentUser) {
      apiVerifyToken(token, wsPort || 3001).then((res) => {
        if (!res.valid) {
          console.warn("[AUTH] JWT Token không hợp lệ hoặc đã hết hạn. Buộc đăng xuất.");
          handleLogout();
        }
      });
    }
  }, []);

  useEffect(() => {
    if (activePeer) {
      loadHistory(activePeer);
    }
  }, [activePeer, loadHistory]);

  const handleLoginSuccess = (user: AuthUser, token?: string) => {
    setCurrentUser(user);
    setWsPort(user.nodePort);
    // Dùng sessionStorage để mở nhiều tab/cửa sổ cùng lúc không bị đè tài khoản
    sessionStorage.setItem("p2p_current_user", JSON.stringify(user));
    if (token) {
      sessionStorage.setItem("p2p_auth_token", token);
    }
    // Giữ sạch đường dẫn URL, không đính kèm ?port=
    window.history.replaceState({}, "", window.location.pathname);
  };

  const handleLogout = () => {
    sessionStorage.removeItem("p2p_current_user");
    sessionStorage.removeItem("p2p_auth_token");
    localStorage.removeItem("p2p_current_user");
    localStorage.removeItem("p2p_auth_token");
    setCurrentUser(null);
    setWsPort(null);
    window.history.replaceState({}, "", window.location.pathname);
  };

  if (!currentUser || !wsPort || !connected) {
    return (
      <LoginModal
        defaultPort={wsPort || 3001}
        onLoginSuccess={handleLoginSuccess}
      />
    );
  }

  const activePeerInfo =
    knownPeers.find((p) => p.displayName === activePeer) ||
    peers.find((p) => p.displayName === activePeer);
  const isPeerOnline = peers.some((p) => p.displayName === activePeer);
  const isPeerBlocked = activePeer ? blockedPeers.includes(activePeer) : false;

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-white text-[#0F172A] font-sans antialiased">
      {/* Alert Banner if any */}
      <AlertBanner message={errorAlert} onClose={clearAlert} />

      {/* Main 3-column workbench */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Column 1: Peers List Sidebar */}
        <Sidebar
          me={currentUser.displayName || me}
          tcpPort={tcpPort}
          peers={knownPeers}
          blockedPeers={blockedPeers}
          activePeer={activePeer}
          onSelectPeer={(name) => setActivePeer(name)}
          onLogout={handleLogout}
        />

        {/* Column 2: Chat & File Transfer Stream */}
        <ChatArea
          activePeer={activePeer}
          isPeerOnline={isPeerOnline}
          isPeerBlocked={isPeerBlocked}
          peerInfo={activePeerInfo}
          channelStatus={channelStatus}
          messages={messages}
          fileTransfers={fileTransfers}
          onSendMessage={(body) => activePeer && sendChat(activePeer, body)}
          onSendFile={(filePath) => activePeer && sendFile(activePeer, filePath)}
          onDeleteHistory={() => activePeer && deleteHistory(activePeer)}
          onToggleFirewallBlock={(blocked) => activePeer && toggleFirewallBlock(activePeer, blocked)}
        />

        {/* Column 3: TCP Protocol Inspector Panel */}
        <ProtocolLogs
          logs={logs}
          isOpen={isLogsOpen}
          onToggle={() => setIsLogsOpen(!isLogsOpen)}
          me={currentUser.displayName || me}
          tcpPort={tcpPort}
          activePeer={activePeer}
          activePeerInfo={activePeerInfo}
          isPeerBlocked={isPeerBlocked}
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
