/**
 * Protocol and Data Transfer Types
 * Distributed Systems (§9.1-9.3) - Secure P2P Network
 */

export type PacketType =
  | 'HANDSHAKE_INIT'
  | 'HANDSHAKE_RESPOND'
  | 'HANDSHAKE_CONFIRM'
  | 'SESSION_KEY_EXCHANGE'
  | 'SECURE_MESSAGE'
  | 'SECURE_FILE'
  | 'UNKNOWN';

export type PacketStatus = 'HELD' | 'FORWARDED' | 'TAMPERED' | 'REPLAYED' | 'SPOOFED';

export type ProxyMode = 'passthrough' | 'hold';

export interface PacketRecord {
  packet_id: string;
  direction: string;
  packet_type: PacketType;
  status: PacketStatus;
  target_url: string;
  raw_json: Record<string, any>;
  intercepted_at: string;
  forwarded_at?: string;
  modified_json?: Record<string, any>;
  attack_type?: string;
  attack_details?: Record<string, any>;
  receiver_response?: Record<string, any>;
}

export interface CertDetails {
  subject: string;
  issuer: string;
  serial_number: string;
  not_before: string;
  not_after: string;
  signature_alg: string;
}

export interface IdentityInfo {
  node_id: string;
  is_registered: boolean;
  public_key_fingerprint: string;
  public_key_pem: string;
  certificate?: CertDetails;
  certificate_pem?: string;
  ca_public_key_pem?: string;
  ca_cert_pem?: string;
}

export interface SessionInfo {
  session_id: string;
  peer_id: string;
  role: 'INITIATOR' | 'RECEIVER';
  created_at: string;
  messages_count: number;
}

export interface VerificationTier {
  status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'PENDING';
  detail?: string;
  timestamp?: string;
}

export interface VerificationResult {
  layer1_replay: 'PASSED' | 'FAILED' | 'SKIPPED' | 'PENDING';
  layer2_gcm: 'PASSED' | 'FAILED' | 'SKIPPED' | 'PENDING';
  layer3_signature: 'PASSED' | 'FAILED' | 'SKIPPED' | 'PENDING';
  error_code?: string;
  detail?: string;
}

export interface DecryptionLogEntry {
  id: string;
  timestamp: string;
  from: string;
  to: string;
  type: 'MESSAGE' | 'FILE' | 'HANDSHAKE' | 'SESSION';
  message_id?: string;
  plaintext?: string;
  filename?: string;
  size_bytes?: number;
  status: 'SUCCESS' | 'FAILED';
  verification: VerificationResult;
  error_code?: string;
  detail?: string;
  raw_packet?: any;
}

export interface SecurityAlert {
  id: string;
  timestamp: string;
  alert_type: string;
  stage: string;
  from: string;
  detail: string;
  layer_failed?: number;
  raw_packet?: any;
}

export interface ChatMessage {
  id: string;
  from: string;
  to: string;
  direction: 'SENT' | 'RECEIVED';
  timestamp: string;
  type: 'text' | 'file';
  content: string;
  filename?: string;
  size_bytes?: number;
  verified: boolean;
  security_status: 'SECURE' | 'TAMPERED' | 'REPLAYED' | 'SPOOFED' | 'PENDING';
  error_detail?: string;
}

export interface PeerItem {
  peer_id: string;
  endpoint: string;
  status: string;
  registered_at?: string;
}

