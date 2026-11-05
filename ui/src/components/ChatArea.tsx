import React, { useState, useRef, useEffect } from "react";
import { MessageRecord, FileTransferProgress, PeerInfo } from "../types";
import {
  Send,
  Paperclip,
  Check,
  CheckCheck,
  Clock,
  Trash2,
  FileText,
  FileCheck,
  Terminal,
  UploadCloud,
  FolderOpen,
  X,
  ChevronDown,
  ChevronUp,
  Shield
} from "lucide-react";

interface ChatAreaProps {
  activePeer: string | null;
  isPeerOnline: boolean;
  peerInfo?: PeerInfo;
  channelStatus: string;
  messages: MessageRecord[];
  fileTransfers: Record<string, FileTransferProgress>;
  onSendMessage: (body: string) => void;
  onSendFile: (filePath: string) => void;
  onDeleteHistory: () => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  activePeer,
  isPeerOnline,
  peerInfo,
  channelStatus,
  messages,
  fileTransfers,
  onSendMessage,
  onSendFile,
  onDeleteHistory,
}) => {
  const [text, setText] = useState("");
  const [showFileModal, setShowFileModal] = useState(false);
  const [filePathInput, setFilePathInput] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isEventBarExpanded, setIsEventBarExpanded] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, fileTransfers]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSendMessage(text.trim());
    setText("");
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      const nativePath = (file as any).path || file.name;
      setFilePathInput(nativePath);
    }
  };

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      setSelectedFile(file);
      const nativePath = (file as any).path || file.name;
      setFilePathInput(nativePath);
    }
  };

  const handleFileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalPath = filePathInput.trim();
    if (!finalPath) return;
    onSendFile(finalPath);
    setFilePathInput("");
    setSelectedFile(null);
    setShowFileModal(false);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const isEncrypted =
    !channelStatus.toLowerCase().includes("plaintext") &&
    !channelStatus.toLowerCase().includes("chưa mã hóa");

  if (!activePeer) {
    return (
      <main className="flex-1 bg-white flex flex-col items-center justify-center p-8 text-center min-w-0">
        <div className="w-12 h-12 rounded-[8px] bg-[#F8FAFC] border border-[#E2E8F0] flex items-center justify-center text-[#64748B] mb-3">
          <Terminal className="w-6 h-6 stroke-1" />
        </div>
        <h3 className="text-sm font-bold text-[#0F172A] uppercase tracking-wider font-mono">
          Session Idle • No Peer Selected
        </h3>
        <p className="text-sm text-[#64748B] mt-1.5 max-w-sm leading-relaxed font-sans">
          Chọn một nút Peer từ danh sách mạng bên trái để bắt đầu kiểm thử phiên truyền Socket TCP và quan sát gói tin.
        </p>
      </main>
    );
  }

  const remoteAddr = peerInfo
    ? `${peerInfo.ip}:${peerInfo.tcpPort}`
    : activePeer
    ? `${activePeer}:8002`
    : "127.0.0.1:8002";

  return (
    <main className="flex-1 bg-white flex flex-col h-full min-w-0">
      {/* 1. Top Header (height: 64px, full-width with 28px padding) */}
      <div className="h-[64px] min-h-[64px] border-b border-[#E2E8F0] bg-white px-[28px] flex items-center justify-between flex-shrink-0 z-10">
        <div className="flex items-center space-x-3.5 min-w-0">
          <div className="relative flex-shrink-0">
            <div className="w-10 h-10 rounded-[8px] bg-[#E2E8F0] text-[#0F172A] font-mono font-bold text-[15px] flex items-center justify-center uppercase">
              {activePeer.substring(0, 2)}
            </div>
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-white ${
                isPeerOnline ? "bg-[#10B981]" : "bg-[#94A3B8]"
              }`}
            />
          </div>

          <div className="min-w-0 flex items-center flex-wrap gap-x-3 gap-y-0.5">
            <span className="text-[17px] font-bold text-[#0F172A] font-sans truncate">
              {activePeer}
            </span>

            <span className="font-mono text-[13px] text-[#64748B]">
              {remoteAddr}
            </span>

            {/* Sleek, flat bordered badge */}
            {isEncrypted ? (
              <span className="inline-flex items-center text-[12px] font-mono font-medium text-[#065F46] bg-[#ECFDF5] border border-[#A7F3D0] px-2.5 py-1 rounded-[4px]">
                AES-256 E2E
              </span>
            ) : (
              <span
                className="inline-flex items-center text-[12px] font-mono font-medium text-[#B45309] bg-[#FFFBEB] border border-[#FDE68A] px-2.5 py-1 rounded-[4px]"
                title="Dữ liệu truyền trực tiếp qua TCP Socket không mã hóa payload"
              >
                PLAINTEXT
              </span>
            )}
          </div>
        </div>

        {/* Clear History Ghost Button */}
        <div className="flex-shrink-0">
          {confirmDelete ? (
            <div className="flex items-center space-x-1.5 bg-[#F8FAFC] p-1 rounded-[6px] border border-[#E2E8F0]">
              <span className="text-[12px] font-mono text-[#64748B] px-1.5">Xác nhận xóa?</span>
              <button
                onClick={() => {
                  onDeleteHistory();
                  setConfirmDelete(false);
                }}
                className="text-[12px] font-mono bg-[#0F172A] hover:bg-[#1E293B] text-white px-2.5 py-1 rounded-[4px] transition-colors font-medium"
              >
                XÓA
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-[12px] font-mono text-[#64748B] hover:text-[#0F172A] px-2 py-1"
              >
                HỦY
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-[#64748B] hover:text-[#0F172A] p-2 rounded-[6px] hover:bg-[#F1F5F9] transition-colors"
              title="Xóa toàn bộ lịch sử tin nhắn với peer này"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 2. Sub-header (Connection Bar, height: 40px, full-width with 28px padding) */}
      <div className="h-[40px] min-h-[40px] border-b border-[#E2E8F0] bg-[#F8FAFC] px-[28px] text-[12.5px] font-mono text-[#64748B] flex items-center justify-between select-none">
        <div className="flex items-center gap-2.5 truncate">
          <span className="flex items-center gap-1.5 font-semibold text-[#0F172A] flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] inline-block" />
            TCP_SOCKET
          </span>
          <span className="text-[#CBD5E1]">|</span>
          <span className="truncate">
            PEER: <strong className="text-[#0F172A] font-medium">{remoteAddr}</strong>
          </span>
          <span className="text-[#CBD5E1] hidden sm:inline">|</span>
          <span className="hidden sm:inline">MTU: 64KB</span>
          <span className="text-[#CBD5E1] hidden md:inline">|</span>
          <span className={`hidden md:inline font-medium ${isEncrypted ? "text-[#10B981]" : "text-[#D97706]"}`}>
            SEC: {isEncrypted ? "AES-256 (SESSION KEY ACTIVE)" : "STAGE-1 PLAINTEXT"}
          </span>
        </div>

        <button
          onClick={() => setIsEventBarExpanded(!isEventBarExpanded)}
          className="border border-[#CBD5E1] bg-white px-3 py-1 rounded-[6px] text-[12px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC] transition-colors flex items-center gap-1.5 shadow-2xs flex-shrink-0 ml-2 cursor-pointer"
          title={isEventBarExpanded ? "Thu gọn chi tiết bắt tay" : "Xem chi tiết bắt tay kết nối"}
        >
          <span>{isEventBarExpanded ? "ẨN HANDSHAKE" : "HANDSHAKE"}</span>
          {isEventBarExpanded ? <ChevronUp className="w-3.5 h-3.5 text-[#64748B]" /> : <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />}
        </button>
      </div>

      {/* Handshake Details Drawer */}
      {isEventBarExpanded && (
        <div className="bg-[#F8FAFC] border-b border-[#E2E8F0] px-[28px] py-3 font-mono text-[12px] space-y-1.5 text-[#0F172A] select-text">
          <div className="flex items-center gap-2">
            <span className="text-[#10B981] font-bold">[OK]</span>
            <span className="text-[#64748B]">Registry discovery resolved:</span>
            <span className="font-semibold text-[#0F172A]">{remoteAddr}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[#10B981] font-bold">[OK]</span>
            <span className="text-[#64748B]">Direct TCP Socket pipe established • Window buffer: 64KB</span>
          </div>
          <div className="flex items-center gap-2">
            {isEncrypted ? (
              <>
                <span className="text-[#10B981] font-bold">[OK]</span>
                <span className="text-[#065F46] font-medium">
                  E2E Encrypted channel active • Kerberos session ticket confirmed
                </span>
              </>
            ) : (
              <>
                <span className="text-[#D97706] font-bold">[WARN]</span>
                <span className="text-[#B45309] font-medium">
                  Unencrypted socket (Plaintext payload) • Stage 1 architecture
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* 3. Chat Stream & Message Bubbles (Full-width with 28px horizontal padding) */}
      <div className="flex-1 overflow-y-auto bg-white px-[28px] py-5 flex flex-col space-y-4 w-full">
        {/* Subtle Session Security Notice Box */}
        <div className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-[8px] px-4 py-3 flex items-center justify-between text-[13px] font-sans text-[#334155] select-none flex-shrink-0">
          <div className="flex items-center space-x-2.5 min-w-0">
            <Shield className={`w-4 h-4 flex-shrink-0 ${isEncrypted ? "text-[#10B981]" : "text-[#D97706]"}`} />
            <span className="truncate">
              Kênh truyền TCP trực tiếp với <strong className="font-semibold text-[#0F172A]">{activePeer}</strong>{" "}
              <span className="font-mono text-[12px] text-[#64748B]">({remoteAddr})</span> • Chế độ:{" "}
              <strong className={isEncrypted ? "text-[#065F46] font-semibold" : "text-[#B45309] font-semibold"}>
                {isEncrypted ? "AES-256 E2E (Đã mã hóa phiên)" : "Plaintext (Chưa mã hóa)"}
              </strong>
              {!isEncrypted && " • Nhấn Handshake để thiết lập khóa phiên"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setIsEventBarExpanded((prev) => !prev)}
            className="text-[12px] font-mono font-medium text-[#64748B] hover:text-[#0F172A] hover:underline flex-shrink-0 ml-3 cursor-pointer"
          >
            {isEventBarExpanded ? "Ẩn chi tiết" : "Chi tiết"}
          </button>
        </div>

        {messages.length === 0 ? (
          <div className="py-20 flex-1 flex flex-col items-center justify-center text-center text-[#64748B] space-y-2">
            <Terminal className="w-8 h-8 text-[#94A3B8] stroke-1 mb-1" />
            <p className="text-xs font-mono uppercase tracking-wider font-semibold text-[#0F172A]">
              Kênh truyền TCP đang rỗng
            </p>
            <p className="text-xs text-[#64748B] max-w-sm font-sans leading-relaxed">
              Nhập tin nhắn hoặc gửi tệp bên dưới để bắt đầu trao đổi dữ liệu trực tiếp qua Socket.
            </p>
          </div>
        ) : (
            messages.map((msg, index) => {
              const isMe = msg.direction === "out";
              const prevMsg = index > 0 ? messages[index - 1] : null;
              const nextMsg = index < messages.length - 1 ? messages[index + 1] : null;

              const isFirstInGroup = !prevMsg || prevMsg.direction !== msg.direction;
              const isLastInGroup = !nextMsg || nextMsg.direction !== msg.direction;

              const timeFormatted = new Date(msg.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              });

              const fileProgress = msg.file_id ? fileTransfers[msg.file_id] : null;

              return (
                <div
                  key={msg.message_id}
                  className={`flex flex-col ${isMe ? "items-end" : "items-start"} ${
                    isFirstInGroup ? (index === 0 ? "mt-0" : "mt-4") : "mt-1"
                  }`}
                >
                  {/* Message Bubble: Solid surfaces, padding 10px 16px, border-radius 10px, max-width 65% */}
                  <div
                    className={`max-w-[65%] px-4 py-2.5 text-[15px] leading-[1.5] transition-all ${
                      isMe
                        ? `bg-[#18181B] text-white rounded-[10px] ${
                            !isFirstInGroup ? "rounded-tr-[3px]" : ""
                          } ${!isLastInGroup ? "rounded-br-[3px]" : ""}`
                        : `bg-[#F1F5F9] text-[#0F172A] border border-[#E2E8F0] rounded-[10px] ${
                            !isFirstInGroup ? "rounded-tl-[3px]" : ""
                          } ${!isLastInGroup ? "rounded-bl-[3px]" : ""}`
                    }`}
                  >
                    {msg.type === "file" ? (
                      <div className="space-y-2 min-w-[240px]">
                        <div className="flex items-center space-x-3">
                          <div
                            className={`w-8 h-8 rounded-[6px] flex items-center justify-center flex-shrink-0 ${
                              isMe ? "bg-zinc-800 text-zinc-200" : "bg-[#E2E8F0] text-[#0F172A]"
                            }`}
                          >
                            {fileProgress?.status === "completed" ? (
                              <FileCheck className="w-4 h-4 text-[#10B981]" />
                            ) : (
                              <FileText className="w-4 h-4" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <span className="font-semibold text-[15px] font-sans break-all line-clamp-1">
                              {msg.body}
                            </span>
                            <div
                              className={`text-[11.5px] font-mono ${
                                isMe ? "text-zinc-400" : "text-[#64748B]"
                              }`}
                            >
                              TCP Stream • MTU 64KB
                            </div>
                          </div>
                        </div>

                        {/* Progress Bar */}
                        {fileProgress && fileProgress.status === "transferring" && (
                          <div className="space-y-1 pt-1">
                            <div className="w-full bg-black/15 rounded-full h-1.5 overflow-hidden">
                              <div
                                className="bg-[#10B981] h-full transition-all duration-150"
                                style={{ width: `${fileProgress.percent}%` }}
                              />
                            </div>
                            <div className="text-[11px] opacity-80 flex justify-between font-mono">
                              <span>{fileProgress.percent}%</span>
                              <span>
                                {fileProgress.transferredChunks}/{fileProgress.totalChunks} chunks
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Inline metadata for file bubble */}
                        <div className="flex items-center justify-between pt-1 font-mono text-[11.5px]">
                          <span
                            className={
                              fileProgress?.status === "completed"
                                ? "text-[#10B981] font-semibold"
                                : isMe
                                ? "text-zinc-400"
                                : "text-[#64748B]"
                          }
                        >
                          {fileProgress?.status === "completed" ? "COMPLETED" : "TCP_CHUNKED"}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1.5 ml-[10px] ${
                            isMe ? "text-zinc-400" : "text-[#64748B]"
                          }`}
                        >
                          <span>{timeFormatted}</span>
                          {isMe && (
                            <span>
                              {msg.status === "delivered" && "✓ ACK"}
                              {msg.status === "sent" && "✓"}
                              {msg.status === "pending" && <Clock className="w-3 h-3 inline" />}
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  ) : (
                    /* Chat message with inline bottom-right metadata */
                    <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
                      <span className="break-words whitespace-pre-wrap font-sans text-[15px] leading-[1.5] flex-1 min-w-[60px]">
                        {msg.body}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 font-mono text-[11.5px] select-none shrink-0 self-end ml-[10px] ${
                          isMe ? "text-zinc-400" : "text-[#64748B]"
                        }`}
                      >
                        <span>{timeFormatted}</span>
                        {isMe && (
                          <span>
                            {msg.status === "delivered" && "✓ ACK"}
                            {msg.status === "sent" && "✓"}
                            {msg.status === "pending" && <Clock className="w-3 h-3 inline" />}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 4. Chat Input Bar (Full-width with 28px horizontal padding) */}
      <div className="border-t border-[#E2E8F0] bg-white py-3.5 px-[28px] flex-shrink-0 w-full">
        <form
          onSubmit={handleSend}
          className="w-full h-[46px] flex items-center gap-2.5 border border-[#CBD5E1] rounded-[8px] bg-[#F8FAFC] px-3 focus-within:bg-white focus-within:border-[#0F172A] transition-colors"
        >
          {/* Attachment icon button (20px icon) */}
          <button
            type="button"
            onClick={() => setShowFileModal(true)}
            className="p-1.5 text-[#64748B] hover:text-[#0F172A] hover:bg-[#E2E8F0]/50 rounded-[6px] transition-colors flex-shrink-0"
            title="Đính kèm và truyền file P2P từ thiết bị"
          >
            <Paperclip className="w-5 h-5" />
          </button>

          {/* Input field (15px font size) */}
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Nhập payload tin nhắn gửi trực tiếp tới ${activePeer}...`}
            className="flex-1 bg-transparent border-none text-[15px] text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:ring-0 px-1 font-sans leading-normal"
          />

          {/* Sharp, flat send button (20px icon) */}
          <button
            type="submit"
            disabled={!text.trim()}
            className={`w-[36px] h-[36px] rounded-[6px] flex items-center justify-center transition-colors flex-shrink-0 ${
              text.trim()
                ? "bg-[#0F172A] text-white hover:bg-[#1E293B] cursor-pointer"
                : "bg-[#E2E8F0] text-[#94A3B8] cursor-not-allowed"
            }`}
            title="Gửi gói tin TCP (Enter)"
          >
            <Send className="w-5 h-5" />
          </button>
        </form>
      </div>

      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* File Transfer Modal */}
      {showFileModal && (
        <div className="fixed inset-0 bg-[#0F172A]/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-[8px] border border-[#E2E8F0] max-w-lg w-full p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
              <div className="flex items-center space-x-2.5">
                <div className="w-7 h-7 rounded-[4px] bg-[#F1F5F9] text-[#0F172A] flex items-center justify-center font-mono">
                  <FolderOpen className="w-4 h-4 text-[#0F172A]" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-[#0F172A] font-mono uppercase tracking-wider">
                    P2P File Transfer Protocol
                  </h4>
                  <p className="text-[11px] text-[#64748B] font-sans">
                    Truyền tệp trực tiếp qua kênh TCP Socket chia đoạn 64KB
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowFileModal(false);
                  setSelectedFile(null);
                  setFilePathInput("");
                }}
                className="text-[#64748B] hover:text-[#0F172A] p-1 rounded-[4px] hover:bg-[#F1F5F9]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Dropzone */}
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleFileDrop}
              className="border border-dashed border-[#CBD5E1] hover:border-[#0F172A] hover:bg-[#F8FAFC] rounded-[6px] p-5 text-center cursor-pointer transition-all space-y-1.5"
            >
              <div className="w-8 h-8 rounded-[4px] bg-[#F1F5F9] text-[#64748B] flex items-center justify-center mx-auto transition-colors">
                <UploadCloud className="w-4 h-4 text-[#64748B]" />
              </div>
              <div>
                <p className="text-xs font-medium text-[#0F172A] font-sans">
                  Chọn tệp từ thiết bị máy tính
                </p>
                <p className="text-[10px] text-[#64748B] mt-0.5 font-mono">
                  hoặc kéo thả tệp vào khung này
                </p>
              </div>
            </div>

            {/* Selected File Details */}
            {selectedFile && (
              <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-[6px] p-2.5 flex items-center justify-between">
                <div className="flex items-center space-x-2.5 truncate">
                  <div className="w-6 h-6 rounded bg-[#ECFDF5] text-[#10B981] flex items-center justify-center flex-shrink-0">
                    <FileCheck className="w-3.5 h-3.5" />
                  </div>
                  <div className="truncate min-w-0">
                    <div className="text-xs font-medium text-[#0F172A] truncate font-mono">
                      {selectedFile.name}
                    </div>
                    <div className="text-[10px] text-[#64748B] font-mono">
                      {formatFileSize(selectedFile.size)} • MTU chunks: 64KB
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedFile(null);
                    setFilePathInput("");
                  }}
                  className="text-[#64748B] hover:text-[#0F172A] p-1 rounded-[4px]"
                  title="Bỏ chọn tệp"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <form onSubmit={handleFileSubmit} className="space-y-3.5">
              <div>
                <label className="block text-[11px] font-semibold text-[#0F172A] mb-1 font-mono uppercase tracking-wider">
                  Target File Path / Name
                </label>
                <input
                  type="text"
                  value={filePathInput}
                  onChange={(e) => setFilePathInput(e.target.value)}
                  placeholder="D:\workspace\report.pdf hoặc data.bin"
                  className="w-full bg-[#F8FAFC] border border-[#CBD5E1] rounded-[6px] px-3 py-1.5 text-xs font-mono text-[#0F172A] focus:outline-none focus:border-[#0F172A] focus:bg-white"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-[#E2E8F0]">
                <button
                  type="button"
                  onClick={() => {
                    setShowFileModal(false);
                    setSelectedFile(null);
                    setFilePathInput("");
                  }}
                  className="px-3 py-1 text-xs text-[#64748B] hover:bg-[#F1F5F9] rounded-[4px] transition-colors font-mono"
                >
                  HỦY
                </button>
                <button
                  type="submit"
                  disabled={!filePathInput.trim()}
                  className="px-3.5 py-1 text-xs bg-[#0F172A] hover:bg-[#1E293B] disabled:bg-[#E2E8F0] disabled:text-[#94A3B8] text-white rounded-[4px] transition-colors font-mono font-medium"
                >
                  STREAM FILE VIA TCP
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
};
