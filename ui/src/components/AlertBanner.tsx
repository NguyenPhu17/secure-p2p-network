import React from "react";
import { AlertCircle, X } from "lucide-react";

interface AlertBannerProps {
  message: string | null;
  onClose: () => void;
}

export const AlertBanner: React.FC<AlertBannerProps> = ({ message, onClose }) => {
  if (!message) return null;

  return (
    <div className="bg-amber-50 border-b border-amber-300 px-4 py-2 flex items-center justify-between text-xs font-mono text-amber-900 select-none z-30">
      <div className="flex items-center space-x-2">
        <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
        <span className="font-semibold uppercase tracking-wider text-[11px] bg-amber-200/60 px-1 py-0.2 rounded">
          ALERT
        </span>
        <span className="font-sans font-medium text-xs text-amber-950">{message}</span>
      </div>
      <button
        onClick={onClose}
        className="text-amber-700 hover:text-amber-950 transition-colors p-1 rounded hover:bg-amber-100 flex-shrink-0"
        title="Đóng thông báo"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
