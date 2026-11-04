import { useEffect, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import { usePacketStore } from '../store/packetStore';
import type { PacketRecord, PacketType, PacketStatus } from '../types/protocol';

const MITM_WS_URL = import.meta.env.VITE_MITM_WS || 'ws://localhost:8080/ws/stream';

export function usePacketStream() {
  const {
    addPacket,
    updatePacket,
    setPackets,
    setConnected,
    refreshPackets,
  } = usePacketStore();

  const handleMessage = useCallback(
    (msg: any) => {
      if (!msg || typeof msg !== 'object') return;

      const event = msg.event;

      switch (event) {
        case 'STREAM_CONNECTED': {
          if (msg.mode) {
            usePacketStore.setState({ mode: msg.mode });
          }
          refreshPackets();
          break;
        }

        case 'PACKET_INTERCEPTED': {
          const raw = msg.raw_json || {};
          const packetType: PacketType = msg.packet_type || raw.type || 'UNKNOWN';
          const direction = msg.direction || `${raw.from || 'A'} → ${raw.to || 'B'}`;
          const status: PacketStatus = msg.status || 'HELD';

          const record: PacketRecord = {
            packet_id: msg.packet_id,
            direction,
            packet_type: packetType,
            status,
            target_url: msg.target_url || '',
            raw_json: raw,
            intercepted_at: msg.intercepted_at || new Date().toISOString(),
          };

          addPacket(record);
          break;
        }

        case 'ATTACK_RESULT': {
          const packetId = msg.packet_id;
          const attackType = msg.attack_type;
          let newStatus: PacketStatus = 'TAMPERED';
          if (attackType === 'REPLAY_ATTACK') newStatus = 'REPLAYED';
          if (attackType === 'SPOOF_IDENTITY') newStatus = 'SPOOFED';

          updatePacket(packetId, {
            status: newStatus,
            attack_type: attackType,
            attack_details: msg.tamper_info || msg.attack_details || { fake_cert_issuer: msg.fake_cert_issuer },
            receiver_response: msg.receiver_response,
            forwarded_at: msg.forwarded_at,
          });
          break;
        }

        case 'PACKET_RELEASED': {
          updatePacket(msg.packet_id, {
            status: 'FORWARDED',
            forwarded_at: msg.timestamp,
          });
          break;
        }

        case 'MODE_CHANGED': {
          usePacketStore.setState({ mode: msg.mode });
          break;
        }

        case 'PACKETS_CLEARED': {
          setPackets([]);
          break;
        }

        default:
          break;
      }
    },
    [addPacket, updatePacket, setPackets, refreshPackets]
  );

  const { isConnected, connect } = useWebSocket({
    url: MITM_WS_URL,
    onMessage: handleMessage,
    onOpen: () => {
      setConnected(true);
      refreshPackets();
    },
    onClose: () => {
      setConnected(false);
    },
  });

  useEffect(() => {
    setConnected(isConnected);
  }, [isConnected, setConnected]);

  return { isConnected, connect };
}
