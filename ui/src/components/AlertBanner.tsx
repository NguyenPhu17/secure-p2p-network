import React from "react";
import { AlertCircle, X } from "lucide-react";

interface AlertBannerProps {
  message: string | null;
  onClose: () => void;
}

export const AlertBanner: React.FC<AlertBannerProps> = ({ message, onClose }) => {
  if (!message) return null;

  return (
    <div className="bg-[#FFFBEB] border-b border-[#FDE68A] px-4 py-2 flex items-center justify-between text-xs font-mono text-[#B45309] select-none z-30">
      <div className="flex items-center space-x-2">
        <AlertCircle className="w-4 h-4 text-[#D97706] flex-shrink-0" />
        <span className="font-semibold uppercase tracking-wider text-[10px] bg-[#FEF3C7] border border-[#FDE68A] px-1 py-0.2 rounded-[3px]">
          ALERT
        </span>
        <span className="font-sans font-medium text-xs text-[#92400E]">{message}</span>
      </div>
      <button
        onClick={onClose}
        className="text-[#B45309] hover:text-[#78350F] transition-colors p-1 rounded-[3px] hover:bg-[#FEF3C7] flex-shrink-0"
        title="Đóng thông báo"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
