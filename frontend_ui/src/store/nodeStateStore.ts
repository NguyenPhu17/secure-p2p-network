import { create } from 'zustand';
import type {
  IdentityInfo,
  SessionInfo,
  DecryptionLogEntry,
  SecurityAlert,
  ChatMessage,
  PeerItem,
} from '../types/protocol';

const NODE_A_API = 'http://localhost:8001';
const NODE_B_API = 'http://localhost:8002';
const CA_API = 'http://localhost:8000';

interface NodeDetail {
  id: string;
  isOnline: boolean;
  identity: IdentityInfo | null;
  sessions: SessionInfo[];
  authenticatedPeers: string[];
  messages: ChatMessage[];
  decryptionLogs: DecryptionLogEntry[];
  securityStatus: 'SECURE' | 'ALERT';
  latestAlert: SecurityAlert | null;
}

interface NodeStateStore {
  nodeA: NodeDetail;
  nodeB: NodeDetail;
  caStatus: {
    isOnline: boolean;
    caCert: string | null;
    activePeers: PeerItem[];
  };
  isHandshaking: boolean;
  isSendingMessage: boolean;
  actionError: string | null;

  // Actions
  setNodeOnline: (nodeId: 'node_a' | 'node_b', online: boolean) => void;
  setNodeIdentity: (nodeId: 'node_a' | 'node_b', identity: IdentityInfo) => void;
  setNodeSessions: (nodeId: 'node_a' | 'node_b', sessions: SessionInfo[]) => void;
  addAuthenticatedPeer: (nodeId: 'node_a' | 'node_b', peerId: string) => void;
  addChatMessage: (nodeId: 'node_a' | 'node_b', message: ChatMessage) => void;
  addDecryptionLog: (nodeId: 'node_a' | 'node_b', log: DecryptionLogEntry) => void;
  setSecurityAlert: (nodeId: 'node_a' | 'node_b', alert: SecurityAlert) => void;
  clearSecurityAlert: (nodeId: 'node_a' | 'node_b') => void;
  setCaOnline: (online: boolean) => void;
  setCaPeers: (peers: PeerItem[]) => void;

  // Async Network Triggers
  fetchNodeStatus: (nodeId: 'node_a' | 'node_b') => Promise<void>;
  fetchCaPeers: () => Promise<void>;
  connectPeerToPeer: (initiatorId: 'node_a' | 'node_b', targetId: string) => Promise<any>;
  sendSecureMessage: (fromId: 'node_a' | 'node_b', targetId: string, content: string) => Promise<any>;
  sendSecureFile: (
    fromId: 'node_a' | 'node_b',
    targetId: string,
    filename: string,
    contentB64: string,
    mimeType?: string
  ) => Promise<any>;
}

const initialNodeState = (id: string): NodeDetail => ({
  id,
  isOnline: false,
  identity: null,
  sessions: [],
  authenticatedPeers: [],
  messages: [],
  decryptionLogs: [],
  securityStatus: 'SECURE',
  latestAlert: null,
});

export const useNodeStateStore = create<NodeStateStore>((set, get) => ({
  nodeA: initialNodeState('node_a'),
  nodeB: initialNodeState('node_b'),
  caStatus: {
    isOnline: false,
    caCert: null,
    activePeers: [],
  },
  isHandshaking: false,
  isSendingMessage: false,
  actionError: null,

  setNodeOnline: (nodeId, online) =>
    set((state) => ({
      [nodeId === 'node_a' ? 'nodeA' : 'nodeB']: {
        ...state[nodeId === 'node_a' ? 'nodeA' : 'nodeB'],
        isOnline: online,
      },
    })),

  setNodeIdentity: (nodeId, identity) =>
    set((state) => ({
      [nodeId === 'node_a' ? 'nodeA' : 'nodeB']: {
        ...state[nodeId === 'node_a' ? 'nodeA' : 'nodeB'],
        identity,
      },
    })),

  setNodeSessions: (nodeId, sessions) =>
    set((state) => ({
      [nodeId === 'node_a' ? 'nodeA' : 'nodeB']: {
        ...state[nodeId === 'node_a' ? 'nodeA' : 'nodeB'],
        sessions,
      },
    })),

  addAuthenticatedPeer: (nodeId, peerId) =>
    set((state) => {
      const key = nodeId === 'node_a' ? 'nodeA' : 'nodeB';
      const existing = state[key].authenticatedPeers;
      if (existing.includes(peerId)) return state;
      return {
        [key]: {
          ...state[key],
          authenticatedPeers: [...existing, peerId],
        },
      };
    }),

  addChatMessage: (nodeId, message) =>
    set((state) => {
      const key = nodeId === 'node_a' ? 'nodeA' : 'nodeB';
      // Avoid duplicates
      const exists = state[key].messages.some((m) => m.id === message.id);
      if (exists) return state;
      return {
        [key]: {
          ...state[key],
          messages: [...state[key].messages, message],
        },
      };
    }),

  addDecryptionLog: (nodeId, log) =>
    set((state) => {
      const key = nodeId === 'node_a' ? 'nodeA' : 'nodeB';
      const exists = state[key].decryptionLogs.some((l) => l.id === log.id);
      const updatedLogs = exists
        ? state[key].decryptionLogs.map((l) => (l.id === log.id ? log : l))
        : [log, ...state[key].decryptionLogs];

      const isSuccess = log.status === 'SUCCESS';
      return {
        [key]: {
          ...state[key],
          decryptionLogs: updatedLogs.slice(0, 50),
          securityStatus: isSuccess ? 'SECURE' : 'ALERT',
        },
      };
    }),

  setSecurityAlert: (nodeId, alert) =>
    set((state) => {
      const key = nodeId === 'node_a' ? 'nodeA' : 'nodeB';
      return {
        [key]: {
          ...state[key],
          securityStatus: 'ALERT',
          latestAlert: alert,
        },
      };
    }),

  clearSecurityAlert: (nodeId) =>
    set((state) => {
      const key = nodeId === 'node_a' ? 'nodeA' : 'nodeB';
      return {
        [key]: {
          ...state[key],
          securityStatus: 'SECURE',
          latestAlert: null,
        },
      };
    }),

  setCaOnline: (online) =>
    set((state) => ({
      caStatus: { ...state.caStatus, isOnline: online },
    })),

  setCaPeers: (peers) =>
    set((state) => ({
      caStatus: { ...state.caStatus, activePeers: peers },
    })),

  fetchNodeStatus: async (nodeId) => {
    const baseUrl = nodeId === 'node_a' ? NODE_A_API : NODE_B_API;
    try {
      const res = await fetch(`${baseUrl}/status`);
      if (res.ok) {
        const data = await res.json();
        set((state) => ({
          [nodeId === 'node_a' ? 'nodeA' : 'nodeB']: {
            ...state[nodeId === 'node_a' ? 'nodeA' : 'nodeB'],
            isOnline: true,
            identity: data.identity,
            sessions: data.active_sessions || [],
            authenticatedPeers: data.authenticated_peers || [],
          },
        }));
      } else {
        get().setNodeOnline(nodeId, false);
      }
    } catch {
      get().setNodeOnline(nodeId, false);
    }
  },

  fetchCaPeers: async () => {
    try {
      const res = await fetch(`${CA_API}/peers`);
      if (res.ok) {
        const data = await res.json();
        set((state) => ({
          caStatus: {
            ...state.caStatus,
            isOnline: true,
            activePeers: data.peers || [],
          },
        }));
      }
    } catch {
      set((state) => ({
        caStatus: { ...state.caStatus, isOnline: false },
      }));
    }
  },

  connectPeerToPeer: async (initiatorId, targetId) => {
    set({ isHandshaking: true, actionError: null });
    const baseUrl = initiatorId === 'node_a' ? NODE_A_API : NODE_B_API;
    try {
      const res = await fetch(`${baseUrl}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_peer_id: targetId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || data.response?.detail || 'Handshake failed');
      }

      // Add targetId to authenticatedPeers and refresh status
      get().addAuthenticatedPeer(initiatorId, targetId);
      await get().fetchNodeStatus('node_a');
      await get().fetchNodeStatus('node_b');
      set({ isHandshaking: false });
      return data;
    } catch (err: any) {
      set({ isHandshaking: false, actionError: err.message });
      throw err;
    }
  },

  sendSecureMessage: async (fromId, targetId, content) => {
    set({ isSendingMessage: true, actionError: null });
    const baseUrl = fromId === 'node_a' ? NODE_A_API : NODE_B_API;
    try {
      const res = await fetch(`${baseUrl}/send/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_peer_id: targetId,
          content,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Failed to send message');
      }

      // Record outbound message in sender's state
      get().addChatMessage(fromId, {
        id: data.message_id || String(Date.now()),
        from: fromId,
        to: targetId,
        direction: 'SENT',
        timestamp: new Date().toISOString(),
        type: 'text',
        content,
        verified: true,
        security_status: 'SECURE',
      });

      set({ isSendingMessage: false });
      return data;
    } catch (err: any) {
      set({ isSendingMessage: false, actionError: err.message });
      throw err;
    }
  },

  sendSecureFile: async (fromId, targetId, filename, contentB64, mimeType) => {
    set({ isSendingMessage: true, actionError: null });
    const baseUrl = fromId === 'node_a' ? NODE_A_API : NODE_B_API;
    try {
      const res = await fetch(`${baseUrl}/send/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_peer_id: targetId,
          filename,
          content_b64: contentB64,
          mime_type: mimeType || 'application/octet-stream',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Failed to send file');
      }

      get().addChatMessage(fromId, {
        id: data.message_id || String(Date.now()),
        from: fromId,
        to: targetId,
        direction: 'SENT',
        timestamp: new Date().toISOString(),
        type: 'file',
        content: `Transferred file: ${filename}`,
        filename,
        size_bytes: data.size_bytes,
        verified: true,
        security_status: 'SECURE',
      });

      set({ isSendingMessage: false });
      return data;
    } catch (err: any) {
      set({ isSendingMessage: false, actionError: err.message });
      throw err;
    }
  },
}));
