import { useEffect, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import { useNodeStateStore } from '../store/nodeStateStore';
import type {
  DecryptionLogEntry,
  SecurityAlert,
  ChatMessage,
  VerificationResult,
} from '../types/protocol';

const NODE_A_WS = import.meta.env.VITE_NODE_A_WS || 'ws://localhost:8001/dashboard';
const NODE_B_WS = import.meta.env.VITE_NODE_B_WS || 'ws://localhost:8002/dashboard';
const CA_WS = import.meta.env.VITE_CA_WS || 'ws://localhost:8000/events';

export function useNodeState() {
  const {
    setNodeOnline,
    setNodeIdentity,
    addChatMessage,
    addDecryptionLog,
    setSecurityAlert,
    addAuthenticatedPeer,
    fetchNodeStatus,
    fetchCaPeers,
    setCaOnline,
  } = useNodeStateStore();

  // ---------------------------------------------------------------------------
  // Handler for Node A
  // ---------------------------------------------------------------------------
  const handleNodeAMessage = useCallback(
    (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      const event = msg.event;

      if (event === 'IDENTITY_READY' && msg.identity) {
        setNodeIdentity('node_a', msg.identity);
      } else if (event === 'CONNECTION_ESTABLISHED') {
        addAuthenticatedPeer('node_a', msg.peer_id);
        fetchNodeStatus('node_a');
      } else if (event === 'MESSAGE_SENT') {
        const chat: ChatMessage = {
          id: msg.message_id || String(Date.now()),
          from: 'node_a',
          to: msg.to || 'node_b',
          direction: 'SENT',
          timestamp: new Date().toISOString(),
          type: 'text',
          content: msg.plaintext || '',
          verified: true,
          security_status: 'SECURE',
        };
        addChatMessage('node_a', chat);
      } else if (event === 'SECURITY_ALERT') {
        const alert: SecurityAlert = {
          id: String(Date.now()),
          timestamp: new Date().toISOString(),
          alert_type: msg.alert_type || 'ALERT',
          stage: msg.stage || 'UNKNOWN',
          from: msg.from || 'UNKNOWN',
          detail: msg.detail || 'Security anomaly detected',
          layer_failed: msg.layer_failed,
          raw_packet: msg.raw_packet,
        };
        setSecurityAlert('node_a', alert);
      }
    },
    [setNodeIdentity, addAuthenticatedPeer, fetchNodeStatus, addChatMessage, setSecurityAlert]
  );

  // ---------------------------------------------------------------------------
  // Handler for Node B (Receiver)
  // ---------------------------------------------------------------------------
  const handleNodeBMessage = useCallback(
    (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      const event = msg.event;

      if (event === 'IDENTITY_READY' && msg.identity) {
        setNodeIdentity('node_b', msg.identity);
      } else if (event === 'SESSION_ESTABLISHED' || event === 'HANDSHAKE_COMPLETED') {
        addAuthenticatedPeer('node_b', msg.peer_id);
        fetchNodeStatus('node_b');
      } else if (event === 'MESSAGE_RECEIVED') {
        const verification: VerificationResult = msg.verification || {
          layer1_replay: 'PASSED',
          layer2_gcm: 'PASSED',
          layer3_signature: 'PASSED',
        };

        const logEntry: DecryptionLogEntry = {
          id: msg.message_id || `log-${Date.now()}`,
          timestamp: msg.timestamp || new Date().toISOString(),
          from: msg.from || 'node_a',
          to: 'node_b',
          type: 'MESSAGE',
          message_id: msg.message_id,
          plaintext: msg.plaintext,
          status: 'SUCCESS',
          verification,
        };
        addDecryptionLog('node_b', logEntry);

        const chat: ChatMessage = {
          id: msg.message_id || String(Date.now()),
          from: msg.from || 'node_a',
          to: 'node_b',
          direction: 'RECEIVED',
          timestamp: msg.timestamp || new Date().toISOString(),
          type: 'text',
          content: msg.plaintext || '',
          verified: true,
          security_status: 'SECURE',
        };
        addChatMessage('node_b', chat);
      } else if (event === 'FILE_RECEIVED') {
        const verification: VerificationResult = msg.verification || {
          layer1_replay: 'PASSED',
          layer2_gcm: 'PASSED',
          layer3_signature: 'PASSED',
        };

        const logEntry: DecryptionLogEntry = {
          id: `file-${Date.now()}`,
          timestamp: new Date().toISOString(),
          from: msg.from || 'node_a',
          to: 'node_b',
          type: 'FILE',
          filename: msg.filename,
          size_bytes: msg.size_bytes,
          status: 'SUCCESS',
          verification,
        };
        addDecryptionLog('node_b', logEntry);

        const chat: ChatMessage = {
          id: `file-${Date.now()}`,
          from: msg.from || 'node_a',
          to: 'node_b',
          direction: 'RECEIVED',
          timestamp: new Date().toISOString(),
          type: 'file',
          content: `Received file: ${msg.filename} (${msg.size_bytes} bytes)`,
          filename: msg.filename,
          size_bytes: msg.size_bytes,
          verified: true,
          security_status: 'SECURE',
        };
        addChatMessage('node_b', chat);
      } else if (event === 'SECURITY_ALERT') {
        const alert: SecurityAlert = {
          id: String(Date.now()),
          timestamp: new Date().toISOString(),
          alert_type: msg.alert_type || 'ALERT',
          stage: msg.stage || 'UNKNOWN',
          from: msg.from || 'UNKNOWN',
          detail: msg.detail || 'Security anomaly detected',
          layer_failed: msg.layer_failed,
          raw_packet: msg.raw_packet,
        };
        setSecurityAlert('node_b', alert);

        // Also add an audit log entry highlighting the failed layer
        const verification: VerificationResult = {
          layer1_replay: msg.layer_failed === 1 ? 'FAILED' : 'PASSED',
          layer2_gcm: msg.layer_failed === 2 ? 'FAILED' : (msg.layer_failed! > 2 ? 'PASSED' : 'SKIPPED'),
          layer3_signature: msg.layer_failed === 3 ? 'FAILED' : 'SKIPPED',
          error_code: msg.alert_type,
          detail: msg.detail,
        };

        const failedLogEntry: DecryptionLogEntry = {
          id: `alert-${Date.now()}`,
          timestamp: new Date().toISOString(),
          from: msg.from || 'node_a',
          to: 'node_b',
          type: 'MESSAGE',
          status: 'FAILED',
          error_code: msg.alert_type,
          detail: msg.detail,
          verification,
          raw_packet: msg.raw_packet,
        };
        addDecryptionLog('node_b', failedLogEntry);
      }
    },
    [setNodeIdentity, addAuthenticatedPeer, fetchNodeStatus, addDecryptionLog, addChatMessage, setSecurityAlert]
  );

  // ---------------------------------------------------------------------------
  // Handler for CA Server
  // ---------------------------------------------------------------------------
  const handleCaMessage = useCallback(
    (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.event === 'PEER_REGISTERED' || msg.event === 'CERT_REVOKED') {
        fetchCaPeers();
        fetchNodeStatus('node_a');
        fetchNodeStatus('node_b');
      }
    },
    [fetchCaPeers, fetchNodeStatus]
  );

  // WebSocket connections
  const wsNodeA = useWebSocket({
    url: NODE_A_WS,
    onMessage: handleNodeAMessage,
    onOpen: () => {
      setNodeOnline('node_a', true);
      fetchNodeStatus('node_a');
    },
    onClose: () => {
      setNodeOnline('node_a', false);
    },
  });

  const wsNodeB = useWebSocket({
    url: NODE_B_WS,
    onMessage: handleNodeBMessage,
    onOpen: () => {
      setNodeOnline('node_b', true);
      fetchNodeStatus('node_b');
    },
    onClose: () => {
      setNodeOnline('node_b', false);
    },
  });

  const wsCa = useWebSocket({
    url: CA_WS,
    onMessage: handleCaMessage,
    onOpen: () => {
      setCaOnline(true);
      fetchCaPeers();
    },
    onClose: () => {
      setCaOnline(false);
    },
  });

  // Polling fallback to keep status synced even if WS disconnects briefly
  useEffect(() => {
    fetchNodeStatus('node_a');
    fetchNodeStatus('node_b');
    fetchCaPeers();

    const interval = setInterval(() => {
      fetchNodeStatus('node_a');
      fetchNodeStatus('node_b');
      fetchCaPeers();
    }, 6000);

    return () => clearInterval(interval);
  }, [fetchNodeStatus, fetchCaPeers]);

  return {
    isNodeAConnected: wsNodeA.isConnected,
    isNodeBConnected: wsNodeB.isConnected,
    isCaConnected: wsCa.isConnected,
  };
}
