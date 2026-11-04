import { useState, useEffect, useRef, useCallback } from "react";
import { PeerInfo, MessageRecord, FileTransferProgress, ProtocolLogEntry } from "../types";

const isHeartbeatLog = (entry: ProtocolLogEntry): boolean => {
  const type = (entry.messageType || "").toUpperCase();
  const sum = (entry.summary || "").toUpperCase();
  const cat = (entry.category || "").toUpperCase();
  return type.includes("HEARTBEAT") || sum.includes("HEARTBEAT") || cat.includes("HEARTBEAT");
};

/**
 * Tách riêng Heartbeat và các gói tin quan trọng (Chat, ACK, File, Bảo mật, KDC, Hệ thống):
 * Giữ tối đa 30 Heartbeat gần nhất, giữ tối đa 2000 gói quan trọng với cơ chế lọc trùng (dedup),
 * tuyệt đối không để Heartbeat ghi đè hay làm mất các gói tin quan trọng.
 */
function filterAndMergeLogs(
  prevLogs: ProtocolLogEntry[],
  newEntries: ProtocolLogEntry | ProtocolLogEntry[]
): ProtocolLogEntry[] {
  const incoming = Array.isArray(newEntries) ? newEntries : [newEntries];
  if (incoming.length === 0) return prevLogs;

  const seenIds = new Set<string>();
  const combined: ProtocolLogEntry[] = [];

  // Lọc trùng ID để tránh duplicate khi backend cập nhật danh sách
  for (const log of prevLogs) {
    if (log && log.id && !seenIds.has(log.id)) {
      seenIds.add(log.id);
      combined.push(log);
    } else if (log && !log.id) {
      combined.push(log);
    }
  }
  for (const log of incoming) {
    if (log && log.id && !seenIds.has(log.id)) {
      seenIds.add(log.id);
      combined.push(log);
    } else if (log && !log.id) {
      combined.push(log);
    }
  }

  const heartbeats: ProtocolLogEntry[] = [];
  const importantLogs: ProtocolLogEntry[] = [];

  for (const log of combined) {
    if (isHeartbeatLog(log)) {
      heartbeats.push(log);
    } else {
      importantLogs.push(log);
    }
  }

  // Giữ lại tối đa 30 gói Heartbeat mới nhất
  const retainedHeartbeats = heartbeats.slice(-30);

  // Giữ lại tối đa 2000 gói quan trọng (Chat, ACK, File, Handshake, Auth/KDC, System)
  const retainedImportant = importantLogs.slice(-2000);

  // Sắp xếp lại theo timestamp tăng dần để hiển thị đúng thứ tự thời gian
  return [...retainedImportant, ...retainedHeartbeats].sort(
    (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
  );
}

export function usePeerSocket(wsPort: number) {
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState<string>("");
  const [tcpPort, setTcpPort] = useState<number>(0);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [activePeer, setActivePeer] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, MessageRecord[]>>({});
  const [fileTransfers, setFileTransfers] = useState<Record<string, FileTransferProgress>>({});
  const [logs, setLogs] = useState<ProtocolLogEntry[]>([]);
  const [channelStatus, setChannelStatus] = useState<string>("Plaintext (Chưa mã hóa)");
  const [errorAlert, setErrorAlert] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const wsUrl = `ws://127.0.0.1:${wsPort}`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setErrorAlert(null);
    };

    ws.onmessage = (event) => {
      try {
        const { event: evt, data } = JSON.parse(event.data);

        switch (evt) {
          case "INITIAL_STATE":
            setMe(data.me);
            setTcpPort(data.tcpPort);
            setPeers(data.peers);
            setChannelStatus(data.channelStatus);
            if (data.logs) {
              setLogs(filterAndMergeLogs([], data.logs));
            }
            break;

          case "PEER_LIST_UPDATE":
            setPeers(data);
            break;

          case "NEW_MESSAGE": {
            const msg: MessageRecord = data;
            const partner = msg.direction === "out" ? msg.receiver : msg.sender;
            setMessages((prev) => {
              const currentList = prev[partner] || [];
              if (currentList.some((m) => m.message_id === msg.message_id)) {
                return prev;
              }
              return { ...prev, [partner]: [...currentList, msg] };
            });
            break;
          }

          case "MESSAGE_STATUS_UPDATE": {
            const { message_id, status } = data;
            setMessages((prev) => {
              const updated: Record<string, MessageRecord[]> = {};
              for (const [k, list] of Object.entries(prev)) {
                updated[k] = list.map((m) => (m.message_id === message_id ? { ...m, status } : m));
              }
              return updated;
            });
            break;
          }

          case "CHAT_HISTORY": {
            const { peer, messages: histMsgs } = data;
            setMessages((prev) => ({
              ...prev,
              [peer]: histMsgs
            }));
            break;
          }

          case "CHAT_HISTORY_CLEARED": {
            const { peer } = data;
            setMessages((prev) => ({
              ...prev,
              [peer]: []
            }));
            break;
          }

          case "FILE_PROGRESS": {
            const prog: FileTransferProgress = data;
            setFileTransfers((prev) => ({
              ...prev,
              [prog.file_id]: prog
            }));
            break;
          }

          case "FILE_COMPLETED": {
            const { file_id } = data;
            setFileTransfers((prev) => {
              if (prev[file_id]) {
                return {
                  ...prev,
                  [file_id]: { ...prev[file_id], status: "completed", percent: 100 }
                };
              }
              return prev;
            });
            break;
          }

          case "PROTOCOL_LOG": {
            const entry: ProtocolLogEntry = data;
            setLogs((prev) => filterAndMergeLogs(prev, entry));
            break;
          }

          case "ERROR_ALERT":
            setErrorAlert(data);
            break;
        }
      } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
      }
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [wsPort]);

  // Commands
  const sendChat = useCallback((receiver: string, body: string) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ action: "SEND_CHAT", receiver, body }));
    }
  }, []);

  const sendFile = useCallback((receiver: string, filePath: string) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ action: "SEND_FILE", receiver, filePath }));
    }
  }, []);

  const loadHistory = useCallback((peer: string, limit = 50, beforeTimestamp?: number) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ action: "GET_CHAT_HISTORY", peer, limit, beforeTimestamp }));
    }
  }, []);

  const deleteHistory = useCallback((peer: string) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ action: "DELETE_CHAT_HISTORY", peer }));
    }
  }, []);

  return {
    connected,
    me,
    tcpPort,
    peers,
    activePeer,
    setActivePeer,
    messages: activePeer ? messages[activePeer] || [] : [],
    fileTransfers,
    logs,
    channelStatus,
    errorAlert,
    clearAlert: () => setErrorAlert(null),
    sendChat,
    sendFile,
    loadHistory,
    deleteHistory
  };
}

