import React from 'react';

interface StatusLightProps {
  status: 'healthy' | 'online' | 'offline' | 'alert' | 'secure' | 'held';
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  pulse?: boolean;
}

export const StatusLight: React.FC<StatusLightProps> = ({
  status,
  label,
  size = 'md',
  pulse = true,
}) => {
  const isGood = status === 'healthy' || status === 'online' || status === 'secure';
  const isAlert = status === 'alert';
  const isHeld = status === 'held';

  const dotSize = size === 'sm' ? 'w-2 h-2' : size === 'lg' ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5';
  const textSize = size === 'sm' ? 'text-[11px]' : size === 'lg' ? 'text-sm' : 'text-xs';

  let colorClasses = 'bg-rose-500 text-rose-400 border-rose-500/30';
  let dotBg = 'bg-rose-400';

  if (isGood) {
    colorClasses = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
    dotBg = 'bg-emerald-400';
  } else if (isAlert) {
    colorClasses = 'bg-rose-500/15 text-rose-400 border-rose-500/40';
    dotBg = 'bg-rose-500';
  } else if (isHeld) {
    colorClasses = 'bg-amber-500/15 text-amber-400 border-amber-500/40';
    dotBg = 'bg-amber-400';
  } else {
    colorClasses = 'bg-slate-800 text-slate-400 border-slate-700';
    dotBg = 'bg-slate-500';
  }

  const defaultLabel = isGood
    ? 'Online'
    : isAlert
    ? 'Attack Detected'
    : isHeld
    ? 'Held'
    : 'Offline';

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border font-medium ${colorClasses} ${textSize}`}
    >
      <span className="relative flex">
        <span
          className={`${dotSize} rounded-full ${dotBg} ${
            pulse && (isGood || isAlert || isHeld) ? 'animate-ping opacity-75' : ''
          }`}
        />
        <span className={`${dotSize} rounded-full ${dotBg} absolute top-0 left-0`} />
      </span>
      <span>{label || defaultLabel}</span>
    </span>
  );
};

