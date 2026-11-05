/**
 * Giao thức truyền thông cốt lõi giữa các thành phần (Registry, Peer, Channel)
 * Toàn bộ tin nhắn trao đổi qua mạng TCP đều tuân theo chuẩn BaseMessage.
 */

export enum MessageType {
  // Registry & Discovery (Centralized / Legacy)
  REGISTER = "REGISTER",
  REGISTER_ACK = "REGISTER_ACK",
  HEARTBEAT = "HEARTBEAT",
  HEARTBEAT_ACK = "HEARTBEAT_ACK",
  PEER_JOINED = "PEER_JOINED",
  PEER_LEFT = "PEER_LEFT",

  // Decentralized P2P DHT (Kademlia Distributed Hash Table)
  DHT_PING = "DHT_PING",
  DHT_PONG = "DHT_PONG",
  DHT_FIND_NODE = "DHT_FIND_NODE",
  DHT_FIND_NODE_RESP = "DHT_FIND_NODE_RESP",
  DHT_STORE = "DHT_STORE",
  DHT_STORE_ACK = "DHT_STORE_ACK",
  DHT_FIND_VALUE = "DHT_FIND_VALUE",
  DHT_FIND_VALUE_RESP = "DHT_FIND_VALUE_RESP",

  // P2P Chat
  CHAT = "CHAT",
  CHAT_ACK = "CHAT_ACK",

  // P2P File Transfer
  FILE_META = "FILE_META",
  FILE_CHUNK = "FILE_CHUNK",
  FILE_ACK = "FILE_ACK",

  // Generic Error
  ERROR = "ERROR",

  // Mesh Overlay & Multi-hop Relay Routing
  RELAY_FORWARD = "RELAY_FORWARD",
  RELAY_ACK = "RELAY_ACK",

  // Placeholder cho KDC / Security Handshake
  SECURITY_STUB = "SECURITY_STUB"
}

/**
 * Thông tin định danh và địa chỉ kết nối của một Peer
 */
export interface PeerInfo {
  displayName: string;
  ip: string;
  tcpPort: number;
  lastSeen?: number;
  nodeId?: string; // 160-bit hex ID trong không gian Kademlia DHT
}

/**
 * Cấu trúc tin nhắn chuẩn trao đổi qua TCP
 */
export interface BaseMessage<T = any> {
  type: MessageType;          // Loại thông điệp
  message_id: string;        // UUID duy nhất chống trùng lặp
  sender: string;            // Tên người gửi
  receiver: string;          // Tên người nhận ("REGISTRY", "BROADCAST", hoặc tên peer đối phương)
  seq: number;               // Số thứ tự gói tin giữa 2 thực thể
  timestamp: number;         // Unix timestamp (ms)
  payload: T;                // Dữ liệu nghiệp vụ chi tiết

  // ==========================================
  // THIẾT KẾ CHỖ CẮM BẢO MẬT (Giai đoạn 1 để null)
  // ==========================================
  // TODO(SECURITY): Nonce ngẫu nhiên dùng 1 lần để chống tấn công phát lại (Replay attack)
  nonce: string | null;
  // TODO(SECURITY): Mã xác thực thông điệp (HMAC) hoặc Chữ ký số (Digital Signature) để chống giả mạo
  mac_or_signature: string | null;
}

// -------------------------------------------------------------
// PAYLOADS CHO TỪNG LOẠI MESSAGE
// -------------------------------------------------------------

export interface RegisterPayload {
  ip: string;
  tcpPort: number;
}

export interface RegisterAckPayload {
  status: "OK" | "REJECTED";
  reason?: string;
  peers: PeerInfo[];
}

export interface HeartbeatAckPayload {
  serverTime: number;
}

export interface PeerLeftPayload {
  displayName: string;
  reason?: string;
}

export interface ChatPayload {
  body: string;
}

export interface ChatAckPayload {
  ack_message_id: string; // message_id của tin nhắn CHAT gốc
}

export interface FileMetaPayload {
  file_id: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  fileHash: string; // Checksum toàn bộ file (TODO(SECURITY): Thay bằng SHA-256 + Chữ ký)
}

export interface FileChunkPayload {
  file_id: string;
  chunkIndex: number;
  totalChunks: number;
  chunkHash: string; // Checksum của chunk này
  data: string;      // Base64 chunk nhị phân
}

export interface FileAckPayload {
  file_id: string;
  chunkIndex: number;
  status: "OK" | "RETRY";
  error?: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

// -------------------------------------------------------------
// PAYLOADS CHO GIAO THỨC DHT (KADEMLIA DISTRIBUTED HASH TABLE)
// -------------------------------------------------------------

export interface DhtPingPayload {
  senderNodeId: string;
  senderInfo: PeerInfo;
}

export interface DhtPongPayload {
  req_id: string; // message_id của DHT_PING gốc
  responderNodeId: string;
  responderInfo: PeerInfo;
}

export interface DhtFindNodePayload {
  targetNodeId: string;
  senderNodeId: string;
  senderInfo: PeerInfo;
}

export interface DhtFindNodeRespPayload {
  req_id: string; // message_id của DHT_FIND_NODE gốc
  targetNodeId: string;
  nodes: PeerInfo[];
}

export interface DhtStorePayload {
  key: string;
  value: any;
  ttlMs?: number;
  publisher: string;
  publisherNodeId: string;
}

export interface DhtStoreAckPayload {
  req_id: string; // message_id của DHT_STORE gốc
  key: string;
  status: "OK" | "FAILED";
  reason?: string;
}

export interface DhtFindValuePayload {
  key: string;
  senderNodeId: string;
  senderInfo: PeerInfo;
}

export interface DhtFindValueRespPayload {
  req_id: string; // message_id của DHT_FIND_VALUE gốc
  key: string;
  found: boolean;
  value?: any;
  nodes?: PeerInfo[];
}

// -------------------------------------------------------------
// PAYLOADS CHO ĐỊNH TUYẾN ĐA CHẶNG (MULTI-HOP OVERLAY MESH RELAY)
// -------------------------------------------------------------

export interface RelayForwardPayload {
  relaySessionId: string;       // Định danh duy nhất cho phiên định tuyến đa chặng
  originSender: string;         // Peer gốc gửi gói tin (VD: "Alice")
  finalReceiver: string;        // Peer đích nhận cuối cùng (VD: "Bob")
  hopCount: number;             // Số chặng đã đi qua (bắt đầu từ 1)
  maxHops: number;              // Giới hạn chặng tối đa (TTL chống loop, mặc định 3 hoặc 5)
  route: string[];              // Tuyến đường đã đi qua (VD: ["Alice", "Charlie"])
  innerMessage: BaseMessage;    // Toàn bộ gói tin gốc được đóng gói nguyên vẹn
}

export interface RelayAckPayload {
  relaySessionId: string;
  originSender: string;
  finalReceiver: string;
  status: "DELIVERED" | "FORWARDED" | "DROPPED";
  hopCount: number;
  reason?: string;
}



