import { create } from 'zustand';
import type { PacketRecord, PacketType, PacketStatus, ProxyMode } from '../types/protocol';

const MITM_API = import.meta.env.VITE_MITM_API || 'http://localhost:8080';

export interface PacketFlowEvent {
  id: string;
  from: string;
  to: string;
  packetType: PacketType;
  isAttack: boolean;
  status: PacketStatus;
  timestamp: number;
}

interface PacketStoreState {
  packets: PacketRecord[];
  heldPackets: PacketRecord[];
  selectedPacketId: string | null;
  mode: ProxyMode;
  isConnected: boolean;
  filterType: string;
  filterStatus: string;
  lastFlowEvent: PacketFlowEvent | null;
  isAttacking: boolean;
  attackError: string | null;

  // Actions
  setConnected: (connected: boolean) => void;
  setMode: (mode: ProxyMode) => Promise<void>;
  setSelectedPacketId: (packetId: string | null) => void;
  setFilterType: (type: string) => void;
  setFilterStatus: (status: string) => void;
  addPacket: (packet: PacketRecord) => void;
  updatePacket: (packetId: string, updates: Partial<PacketRecord>) => void;
  setPackets: (packets: PacketRecord[]) => void;
  clearPackets: () => Promise<void>;

  // Attack Actions
  tamperPacket: (packetId?: string, path?: string, bitPosition?: number) => Promise<any>;
  replayPacket: (packetId?: string) => Promise<any>;
  spoofPacket: (packetId?: string, fakeIssuer?: string) => Promise<any>;
  releasePacket: (packetId?: string) => Promise<any>;
  refreshPackets: () => Promise<void>;
}

export const usePacketStore = create<PacketStoreState>((set, get) => ({
  packets: [],
  heldPackets: [],
  selectedPacketId: null,
  mode: 'passthrough',
  isConnected: false,
  filterType: 'ALL',
  filterStatus: 'ALL',
  lastFlowEvent: null,
  isAttacking: false,
  attackError: null,

  setConnected: (connected) => set({ isConnected: connected }),

  setMode: async (mode) => {
    try {
      const res = await fetch(`${MITM_API}/attack/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (res.ok) {
        const data = await res.json();
        set({ mode: data.mode });
      }
    } catch (err: any) {
      console.error('Failed to set proxy mode:', err);
    }
  },

  setSelectedPacketId: (packetId) => set({ selectedPacketId: packetId }),

  setFilterType: (filterType) => set({ filterType }),

  setFilterStatus: (filterStatus) => set({ filterStatus }),

  addPacket: (newPacket) => {
    set((state) => {
      // Avoid duplicate packet entries
      const exists = state.packets.some((p) => p.packet_id === newPacket.packet_id);
      let updated: PacketRecord[];
      if (exists) {
        updated = state.packets.map((p) => (p.packet_id === newPacket.packet_id ? { ...p, ...newPacket } : p));
      } else {
        updated = [newPacket, ...state.packets].slice(0, 500);
      }

      const held = updated.filter((p) => p.status === 'HELD');

      // Trigger sequence chart flow animation
      const flow: PacketFlowEvent = {
        id: newPacket.packet_id,
        from: newPacket.direction.split('→')[0]?.trim() || 'A',
        to: newPacket.direction.split('→')[1]?.trim() || 'B',
        packetType: newPacket.packet_type,
        isAttack: ['TAMPERED', 'REPLAYED', 'SPOOFED'].includes(newPacket.status),
        status: newPacket.status,
        timestamp: Date.now(),
      };

      return {
        packets: updated,
        heldPackets: held,
        selectedPacketId: state.selectedPacketId || newPacket.packet_id,
        lastFlowEvent: flow,
      };
    });
  },

  updatePacket: (packetId, updates) => {
    set((state) => {
      const updated = state.packets.map((p) =>
        p.packet_id === packetId ? { ...p, ...updates } : p
      );
      return {
        packets: updated,
        heldPackets: updated.filter((p) => p.status === 'HELD'),
      };
    });
  },

  setPackets: (packets) =>
    set({
      packets,
      heldPackets: packets.filter((p) => p.status === 'HELD'),
    }),

  clearPackets: async () => {
    try {
      await fetch(`${MITM_API}/packets`, { method: 'DELETE' });
      set({ packets: [], heldPackets: [], selectedPacketId: null });
    } catch (err) {
      console.error('Failed to clear packets:', err);
    }
  },

  tamperPacket: async (packetId, path, bitPosition) => {
    set({ isAttacking: true, attackError: null });
    try {
      const res = await fetch(`${MITM_API}/attack/tamper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packet_id: packetId || undefined,
          path: path || undefined,
          bit_position: bitPosition ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Tamper attack failed');

      // Refresh packet store to pick up status change
      await get().refreshPackets();
      set({ isAttacking: false });
      return data;
    } catch (err: any) {
      set({ isAttacking: false, attackError: err.message });
      throw err;
    }
  },

  replayPacket: async (packetId) => {
    set({ isAttacking: true, attackError: null });
    try {
      const res = await fetch(`${MITM_API}/attack/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packet_id: packetId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Replay attack failed');

      await get().refreshPackets();
      set({ isAttacking: false });
      return data;
    } catch (err: any) {
      set({ isAttacking: false, attackError: err.message });
      throw err;
    }
  },

  spoofPacket: async (packetId, fakeIssuer) => {
    set({ isAttacking: true, attackError: null });
    try {
      const res = await fetch(`${MITM_API}/attack/spoof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packet_id: packetId || undefined,
          fake_issuer: fakeIssuer || 'ROGUE_CA',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Spoof attack failed');

      await get().refreshPackets();
      set({ isAttacking: false });
      return data;
    } catch (err: any) {
      set({ isAttacking: false, attackError: err.message });
      throw err;
    }
  },

  releasePacket: async (packetId) => {
    set({ isAttacking: true, attackError: null });
    try {
      const res = await fetch(`${MITM_API}/attack/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packet_id: packetId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Release failed');

      await get().refreshPackets();
      set({ isAttacking: false });
      return data;
    } catch (err: any) {
      set({ isAttacking: false, attackError: err.message });
      throw err;
    }
  },

  refreshPackets: async () => {
    try {
      const res = await fetch(`${MITM_API}/packets?limit=100`);
      if (res.ok) {
        const data = await res.json();
        set({
          packets: data.packets,
          heldPackets: data.packets.filter((p: PacketRecord) => p.status === 'HELD'),
        });
      }
    } catch (err) {
      console.error('Failed to refresh packets:', err);
    }
  },
}));
