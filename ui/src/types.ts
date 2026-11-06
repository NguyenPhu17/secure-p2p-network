export interface PeerInfo {
  displayName: string;
  ip: string;
  tcpPort: number;
  lastSeen?: number;
  nodeId?: string;
}

export interface MessageRecord {
  message_id: string;
  conversation_id: string;
  sender: string;
  receiver: string;
  direction: "in" | "out";
  seq: number;
  timestamp: number;
  lamport_clock?: number;
  vector_clock?: Record<string, number> | null;
  body: string;
  status: "pending" | "sent" | "delivered" | "failed";
  type: "chat" | "file";
  file_id?: string | null;
  created_at: number;
  nonce?: string | null;
  mac_or_signature?: string | null;
  route?: string[] | null;
  relayed_by?: string | null;
}

export interface FileTransferProgress {
  file_id: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  transferredChunks: number;
  percent: number;
  direction: "out" | "in";
  status: "transferring" | "completed" | "failed";
}

export interface ProtocolLogEntry {
  id: string;
  timestamp: number;
  timeStr: string;
  level: "INFO" | "WARN" | "ERROR" | "DEBUG";
  category: string;
  direction?: "IN" | "OUT" | "INTERNAL";
  messageType?: string;
  peer?: string;
  summary: string;
  details?: any;
}

