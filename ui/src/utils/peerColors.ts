export interface PeerColorScheme {
  bg: string;
  text: string;
  border?: string;
}

const PEER_PALETTE: PeerColorScheme[] = [
  { bg: "bg-indigo-600", text: "text-white", border: "border-indigo-700" },
  { bg: "bg-emerald-600", text: "text-white", border: "border-emerald-700" },
  { bg: "bg-amber-600", text: "text-white", border: "border-amber-700" },
  { bg: "bg-rose-600", text: "text-white", border: "border-rose-700" },
  { bg: "bg-violet-600", text: "text-white", border: "border-violet-700" },
  { bg: "bg-teal-600", text: "text-white", border: "border-teal-700" },
  { bg: "bg-cyan-700", text: "text-white", border: "border-cyan-800" },
  { bg: "bg-slate-700", text: "text-white", border: "border-slate-800" },
];

/**
 * Tạo màu sắc đại diện nhất quán cho từng Peer theo tên
 */
export function getPeerColor(name: string): PeerColorScheme {
  if (!name) return PEER_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % PEER_PALETTE.length;
  return PEER_PALETTE[index];
}

