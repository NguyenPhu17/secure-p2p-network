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
  ShieldCheck,
  ShieldAlert,
  UploadCloud,
  FolderOpen,
  X,
  Server,
  Layers,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { getPeerColor } from "../utils/peerColors";

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

  // Tự động cuộn xuống tin nhắn mới nhất
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

  const peerColor = activePeer ? getPeerColor(activePeer) : null;

  if (!activePeer) {
    return (
      <main className="flex-1 bg-tech-dots flex flex-col items-center justify-center p-8 text-center min-w-0">
        <div className="w-12 h-12 rounded-lg bg-white border border-slate-300 shadow-2xs flex items-center justify-center text-slate-500 mb-3 font-mono">
          <Terminal className="w-6 h-6 stroke-1 text-slate-500" />
        </div>
        <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider font-mono">
          Session Idle • No Peer Selected
        </h3>
        <p className="text-xs text-slate-500 mt-1 max-w-sm leading-relaxed font-sans">
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
    <main className="flex-1 bg-tech-dots flex flex-col h-full min-w-0">
      {/* Header cuộc trò chuyện - Phong cách Postman / Workbench */}
      <div className="h-13 min-h-[3.25rem] border-b border-slate-200 bg-white px-4 md:px-5 flex items-center justify-between flex-shrink-0 z-10">
        <div className="flex items-center space-x-3 min-w-0">
          <div className="relative flex-shrink-0">
            <div
              className={`w-9 h-9 rounded-md flex items-center justify-center text-xs font-mono font-bold uppercase ${
                peerColor ? `${peerColor.bg} ${peerColor.text}` : "bg-slate-800 text-white"
              }`}
            >
              {activePeer.substring(0, 2)}
            </div>
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-white ${
                isPeerOnline ? "bg-emerald-500" : "bg-slate-400"
              }`}
            />
          </div>

          <div className="min-w-0">
            <div className="flex items-center space-x-2">
              <h3 className="text-sm font-bold text-slate-900 leading-none truncate font-sans">
                {activePeer}
              </h3>

              {/* Chỉ báo trạng thái bảo mật dạng kỹ thuật */}
              {isEncrypted ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-mono font-semibold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-300">
                  <ShieldCheck className="w-3 h-3 text-emerald-600 flex-shrink-0" />
                  <span>AES-256 E2E</span>
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-mono font-semibold text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-300"
                  title="Dữ liệu truyền trực tiếp qua TCP Socket không mã hóa payload"
                >
                  <ShieldAlert className="w-3 h-3 text-amber-600 flex-shrink-0" />
                  <span>PLAINTEXT (NO KEY)</span>
                </span>
              )}
            </div>

            {/* Trạng thái kết nối & IP:Port kỹ thuật Monospace */}
            <div className="text-[11px] font-mono text-slate-500 mt-1 flex items-center space-x-2">
              <span className="flex items-center space-x-1.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full inline-block ${
                    isPeerOnline ? "bg-emerald-500" : "bg-slate-400"
                  }`}
                />
                <span className="text-slate-600 font-medium">
                  {isPeerOnline ? "ONLINE" : "OFFLINE"}
                </span>
              </span>

              {peerInfo && (
                <>
                  <span className="text-slate-300">/</span>
                  <span className="text-slate-700 font-medium">
                    {peerInfo.ip}:{peerInfo.tcpPort}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Nút Xóa lịch sử */}
        <div className="flex-shrink-0">
          {confirmDelete ? (
            <div className="flex items-center space-x-1.5 bg-slate-50 p-1 rounded-md border border-slate-300">
              <span className="text-xs font-mono text-slate-600 px-1">Xác nhận xóa?</span>
              <button
                onClick={() => {
                  onDeleteHistory();
                  setConfirmDelete(false);
                }}
                className="text-xs font-mono bg-rose-600 hover:bg-rose-700 text-white px-2 py-0.5 rounded transition-colors font-medium"
              >
                XÓA
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-xs font-mono text-slate-500 hover:text-slate-800 px-1.5 py-0.5"
              >
                HỦY
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-slate-400 hover:text-rose-600 p-1.5 rounded-md hover:bg-rose-50 border border-transparent hover:border-rose-200 transition-colors"
              title="Xóa toàn bộ lịch sử tin nhắn với peer này"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 
        YÊU CẦU 1: System Event Bar dạng dòng lệnh (Monospace) tối giản
        Bám sát ngay dưới phần Header, thay thế hoàn toàn card handshake log giữa màn hình
      */}
      <div className="border-b border-slate-200 bg-slate-900 text-slate-300 px-4 py-1.5 text-[11px] font-mono flex items-center justify-between select-none">
        <div className="flex items-center gap-2 truncate">
          <span className="text-emerald-400 font-bold flex items-center gap-1.5 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-pulse" />
            TCP_SOCKET
          </span>
          <span className="text-slate-600">/</span>
          <span className="text-slate-300 truncate">
            PEER: <strong className="text-slate-100 font-semibold">{remoteAddr}</strong>
          </span>
          <span className="text-slate-600 hidden sm:inline">|</span>
          <span className="text-slate-400 hidden sm:inline">MTU: 64KB</span>
          <span className="text-slate-600 hidden md:inline">|</span>
          <span className={`hidden md:inline font-semibold ${isEncrypted ? "text-emerald-400" : "text-amber-400"}`}>
            SEC: {isEncrypted ? "AES-256 (SESSION KEY ACTIVE)" : "STAGE-1 PLAINTEXT"}
          </span>
        </div>

        <button
          onClick={() => setIsEventBarExpanded(!isEventBarExpanded)}
          className="text-slate-400 hover:text-slate-200 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-800 transition-colors flex-shrink-0 ml-2"
          title={isEventBarExpanded ? "Thu gọn chi tiết bắt tay" : "Xem chi tiết bắt tay kết nối"}
        >
          <span className="text-[10px] uppercase font-bold tracking-wider">
            {isEventBarExpanded ? "Ẩn chi tiết" : "Handshake"}
          </span>
          {isEventBarExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {/* Chi tiết Handshake mỏng khi mở rộng */}
      {isEventBarExpanded && (
        <div className="bg-slate-950 border-b border-slate-800 px-4 py-2 font-mono text-[11px] space-y-1 text-slate-300 select-text">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400 font-bold">[OK]</span>
            <span>Registry discovery resolved:</span>
            <span className="text-white font-semibold">{remoteAddr}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-emerald-400 font-bold">[OK]</span>
            <span>Direct TCP Socket pipe established • Window buffer: 64KB</span>
          </div>
          <div className="flex items-center gap-2">
            {isEncrypted ? (
              <>
                <span className="text-emerald-400 font-bold">[OK]</span>
                <span className="text-emerald-300 font-medium">
                  E2E Encrypted channel active • Kerberos session ticket confirmed
                </span>
              </>
            ) : (
              <>
                <span className="text-amber-400 font-bold">[WARN]</span>
                <span className="text-amber-300 font-medium">
                  Unencrypted socket (Plaintext payload) • Stage 1 architecture
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* 
        YÊU CẦU 2: Tái cấu trúc khung Chat & Bong bóng tin nhắn
        - Thu hẹp khoảng cách: space-y-2.5 thay vì space-y-4
        - Bỏ rounded-2xl, chuyển sang rounded-lg
        - Viền mảnh border-slate-200/border-slate-800 tạo chiều sâu công nghệ
      */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4">
        <div className="max-w-4xl xl:max-w-5xl mx-auto w-full space-y-2.5">
          {messages.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-center text-slate-400 space-y-1.5">
              <Terminal className="w-8 h-8 text-slate-300 stroke-1 mb-1" />
              <p className="text-xs font-mono uppercase tracking-wider font-semibold text-slate-600">
                Kênh truyền TCP đang rỗng
              </p>
              <p className="text-xs text-slate-400 max-w-xs font-sans">
                Nhập tin nhắn hoặc gửi tệp bên dưới để bắt đầu trao đổi dữ liệu trực tiếp qua Socket.
              </p>
            </div>
          ) : (
            messages.map((msg) => {
              const isMe = msg.direction === "out";
              const timeFormatted = new Date(msg.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });

              const fileProgress = msg.file_id ? fileTransfers[msg.file_id] : null;

              return (
                <div
                  key={msg.message_id}
                  className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}
                >
                  {/* Bong bóng tin nhắn: Bo góc vừa phải (rounded-lg) và viền mảnh sắc cạnh */}
                  <div
                    className={`max-w-lg lg:max-w-2xl rounded-lg px-3.5 py-2.5 text-sm md:text-[14.5px] leading-relaxed transition-all shadow-2xs ${
                      isMe
                        ? "bg-slate-900 text-slate-100 border border-slate-800"
                        : "bg-white text-slate-900 border border-slate-200"
                    }`}
                  >
                    {msg.type === "file" ? (
                      <div className="space-y-2 min-w-[240px]">
                        <div className="flex items-center space-x-2.5">
                          <div
                            className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 ${
                              isMe ? "bg-slate-800 text-slate-200" : "bg-slate-100 text-slate-700"
                            }`}
                          >
                            {fileProgress?.status === "completed" ? (
                              <FileCheck className="w-4 h-4 text-emerald-400" />
                            ) : (
                              <FileText className="w-4 h-4" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <span className="font-semibold text-xs md:text-sm font-sans break-all line-clamp-1">
                              {msg.body}
                            </span>
                            <div
                              className={`text-[11px] font-mono ${
                                isMe ? "text-slate-400" : "text-slate-500"
                              }`}
                            >
                              TCP P2P Stream • MTU 64KB
                            </div>
                          </div>
                        </div>

                        {/* Thanh tiến độ truyền chunk file */}
                        {fileProgress && fileProgress.status === "transferring" && (
                          <div className="space-y-1 pt-1">
                            <div className="w-full bg-black/20 rounded-xs h-1.5 overflow-hidden">
                              <div
                                className="bg-emerald-400 h-full transition-all duration-150 rounded-xs"
                                style={{ width: `${fileProgress.percent}%` }}
                              />
                            </div>
                            <div className="text-[11px] opacity-85 flex justify-between font-mono">
                              <span>{fileProgress.percent}%</span>
                              <span>
                                {fileProgress.transferredChunks}/{fileProgress.totalChunks} chunks
                              </span>
                            </div>
                          </div>
                        )}

                        {fileProgress && fileProgress.status === "completed" && (
                          <div
                            className={`text-[11px] font-mono font-semibold flex items-center gap-1.5 ${
                              isMe ? "text-emerald-300" : "text-emerald-700"
                            }`}
                          >
                            <CheckCheck className="w-3.5 h-3.5" /> HOÀN TẤT TRUYỀN FILE
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="break-words whitespace-pre-wrap">{msg.body}</p>
                    )}
                  </div>

                  {/* Metadata bên dưới tin nhắn: Font monospace kỹ thuật */}
                  <div className="flex items-center space-x-1.5 text-[11px] text-slate-500 mt-1 px-1 font-mono">
                    {!isMe && <span className="font-semibold text-slate-600">{activePeer}</span>}
                    {!isMe && <span className="text-slate-300">•</span>}
                    <span>{timeFormatted}</span>
                    {isMe && (
                      <>
                        <span className="text-slate-300">•</span>
                        {msg.status === "pending" && (
                          <span className="flex items-center text-amber-600">
                            <Clock className="w-3 h-3 mr-0.5" /> QUEUED
                          </span>
                        )}
                        {msg.status === "sent" && (
                          <span className="flex items-center text-slate-500">
                            <Check className="w-3 h-3 mr-0.5" /> SENT_TCP
                          </span>
                        )}
                        {msg.status === "delivered" && (
                          <span className="flex items-center text-emerald-600 font-semibold">
                            <CheckCheck className="w-3 h-3 mr-0.5 text-emerald-600" /> ACK_OK
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* 
        YÊU CẦU 2 (tiếp): Thanh nhập liệu (Input Composer)
        Gộp chung thành một khung duy nhất bám sát đáy, viền 1px sắc cạnh, nút gửi dạng icon phẳng tinh tế
      */}
      <div className="p-2.5 md:p-3 border-t border-slate-200 bg-white">
        <div className="max-w-4xl xl:max-w-5xl mx-auto w-full">
          <form
            onSubmit={handleSend}
            className="flex items-center gap-1.5 bg-slate-50 border border-slate-300 rounded-lg px-2 py-1 transition-all focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-400 focus-within:bg-white"
          >
            {/* Nút đính kèm file dạng icon phẳng */}
            <button
              type="button"
              onClick={() => setShowFileModal(true)}
              className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-200/70 rounded-md transition-colors flex-shrink-0"
              title="Đính kèm và truyền file P2P từ thiết bị"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            {/* Ô nhập tin nhắn */}
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Nhập payload tin nhắn gửi trực tiếp tới ${activePeer}...`}
              className="flex-1 bg-transparent border-none text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-0 px-2 py-1 font-sans"
            />

            {/* Nút gửi phẳng tinh tế không hoa mỹ */}
            <button
              type="submit"
              disabled={!text.trim()}
              className="w-8 h-8 rounded-md bg-slate-900 hover:bg-slate-800 disabled:opacity-20 text-white flex items-center justify-center transition-all flex-shrink-0"
              title="Gửi gói tin TCP (Enter)"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>
      </div>

      {/* Input file ẩn phục vụ chọn file từ thiết bị */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Modal gửi file phong cách Workbench kỹ thuật */}
      {showFileModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg border border-slate-300 max-w-lg w-full p-5 space-y-4 shadow-xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div className="flex items-center space-x-2.5">
                <div className="w-8 h-8 rounded-md bg-slate-100 text-slate-700 flex items-center justify-center font-mono">
                  <FolderOpen className="w-4 h-4 text-slate-700" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-slate-900 font-mono uppercase tracking-wider">
                    P2P File Transfer Protocol
                  </h4>
                  <p className="text-xs text-slate-500 font-sans">
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
                className="text-slate-400 hover:text-slate-600 p-1 rounded-md hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Khu vực bấm chọn file từ thiết bị hoặc kéo thả */}
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleFileDrop}
              className="border border-dashed border-slate-300 hover:border-slate-500 hover:bg-slate-50 rounded-lg p-5 text-center cursor-pointer transition-all space-y-2 group"
            >
              <div className="w-9 h-9 rounded-md bg-slate-100 group-hover:bg-slate-200 text-slate-600 flex items-center justify-center mx-auto transition-colors">
                <UploadCloud className="w-5 h-5 text-slate-600" />
              </div>
              <div>
                <p className="text-xs md:text-sm font-semibold text-slate-800 font-sans">
                  Chọn tệp từ thiết bị máy tính
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5 font-mono">
                  hoặc kéo thả tệp vào khung này
                </p>
              </div>
            </div>

            {/* Chi tiết file đã chọn */}
            {selectedFile && (
              <div className="bg-slate-50 border border-slate-200 rounded-md p-3 flex items-center justify-between">
                <div className="flex items-center space-x-2.5 truncate">
                  <div className="w-7 h-7 rounded bg-emerald-50 text-emerald-600 flex items-center justify-center flex-shrink-0">
                    <FileCheck className="w-4 h-4" />
                  </div>
                  <div className="truncate min-w-0">
                    <div className="text-xs font-semibold text-slate-900 truncate font-mono">
                      {selectedFile.name}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono">
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
                  className="text-slate-400 hover:text-rose-600 p-1 rounded-md"
                  title="Bỏ chọn tệp"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <form onSubmit={handleFileSubmit} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1 font-mono uppercase tracking-wider">
                  Target File Path / Name
                </label>
                <input
                  type="text"
                  value={filePathInput}
                  onChange={(e) => setFilePathInput(e.target.value)}
                  placeholder="D:\workspace\report.pdf hoặc data.bin"
                  className="w-full bg-slate-50 border border-slate-300 rounded-md px-3 py-2 text-xs font-mono text-slate-800 focus:outline-none focus:ring-1 focus:ring-slate-500 focus:bg-white"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    setShowFileModal(false);
                    setSelectedFile(null);
                    setFilePathInput("");
                  }}
                  className="px-3.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-md transition-colors font-mono"
                >
                  HỦY
                </button>
                <button
                  type="submit"
                  disabled={!filePathInput.trim()}
                  className="px-4 py-1.5 text-xs bg-slate-900 hover:bg-slate-800 disabled:opacity-30 text-white rounded-md transition-colors font-mono font-semibold"
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
