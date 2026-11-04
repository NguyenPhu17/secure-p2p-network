/**
 * FileSender - Quản lý việc chia nhỏ và gửi file qua kênh P2P theo từng chunk 64KB
 * Tối ưu RAM: Dùng buffer 64KB duy nhất, đọc từng đoạn từ đĩa và giải phóng ngay.
 *
 * TODO(SECURITY): Thay thế hàm băm đơn giản bằng SHA-256 và ký số từng chunk / toàn file.
 */

import fs from "node:fs";
import path from "node:path";
import { IChannel } from "../../common/channel.js";
import { BaseMessage, MessageType, FileMetaPayload, FileChunkPayload, PeerInfo } from "../../common/protocol.js";
import { calculateChecksum, calculateFileChecksum } from "../../common/checksum.js";
import { Logger } from "../../common/logger.js";
import { config } from "../../common/config.js";

export interface FileTransferProgress {
  file_id: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  transferredChunks: number;
  percent: number;
  direction: "out" | "in";
  status: "transferring" | "completed" | "failed";
  speedBps?: number;
}

export class FileSender {
  private activeTransfers: Map<string, {
    file_id: string;
    fd: number;
    chunkSize: number;
    totalChunks: number;
    pendingAcks: Map<number, (success: boolean) => void>;
  }> = new Map();

  constructor(
    private channel: IChannel,
    private myName: string,
    private logger: Logger
  ) {}

  /**
   * Xử lý gói tin FILE_ACK nhận được từ bên nhận
   */
  public handleFileAck(file_id: string, chunkIndex: number, status: "OK" | "RETRY"): void {
    const transfer = this.activeTransfers.get(file_id);
    if (!transfer) return;

    const resolveAck = transfer.pendingAcks.get(chunkIndex);
    if (resolveAck) {
      transfer.pendingAcks.delete(chunkIndex);
      resolveAck(status === "OK");
    }
  }

  /**
   * Bắt đầu gửi file tới Peer đích
   */
  public async sendFile(
    targetPeer: PeerInfo,
    filePath: string,
    onProgress?: (progress: FileTransferProgress) => void
  ): Promise<{ file_id: string; success: boolean; error?: string }> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File không tồn tại: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const fileName = path.basename(filePath);
    const chunkSize = config.peer.defaultChunkSize; // 64 KB
    const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));
    const file_id = crypto.randomUUID();

    this.logger.info(
      "NETWORK",
      `Chuẩn bị gửi file '${fileName}' (${fileSize} bytes, ${totalChunks} chunks) tới '${targetPeer.displayName}'`
    );

    // 1. Tính hash toàn file theo stream (Tối ưu RAM)
    // TODO(SECURITY): Thay bằng SHA-256 + Chữ ký số
    const fileHash = await calculateFileChecksum(filePath);

    // 2. Gửi message FILE_META
    const metaMsg: BaseMessage<FileMetaPayload> = {
      type: MessageType.FILE_META,
      message_id: crypto.randomUUID(),
      sender: this.myName,
      receiver: targetPeer.displayName,
      seq: 0,
      timestamp: Date.now(),
      payload: {
        file_id,
        fileName,
        fileSize,
        chunkSize,
        totalChunks,
        fileHash
      },
      nonce: null,
      mac_or_signature: null
    };

    const metaSent = await this.channel.sendMessage(targetPeer.ip, targetPeer.tcpPort, metaMsg);
    if (!metaSent) {
      return { file_id, success: false, error: "Không thể gửi FILE_META tới peer" };
    }

    // 3. Mở file descriptor để đọc từng chunk
    const fd = fs.openSync(filePath, "r");
    const pendingAcks = new Map<number, (success: boolean) => void>();
    this.activeTransfers.set(file_id, { file_id, fd, chunkSize, totalChunks, pendingAcks });

    // Tối ưu RAM: 1 buffer duy nhất 64KB tái sử dụng cho toàn bộ quá trình đọc chunk
    const readBuffer = Buffer.allocUnsafe(chunkSize);

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const offset = chunkIndex * chunkSize;
        const bytesToRead = Math.min(chunkSize, fileSize - offset);

        fs.readSync(fd, readBuffer, 0, bytesToRead, offset);
        const actualChunkBuffer = readBuffer.subarray(0, bytesToRead);

        // Tính checksum chunk
        // TODO(SECURITY): Kèm MAC hoặc chữ ký số cho từng chunk
        const chunkHash = calculateChecksum(actualChunkBuffer);
        const chunkBase64 = actualChunkBuffer.toString("base64");

        const chunkMsg: BaseMessage<FileChunkPayload> = {
          type: MessageType.FILE_CHUNK,
          message_id: crypto.randomUUID(),
          sender: this.myName,
          receiver: targetPeer.displayName,
          seq: chunkIndex + 1,
          timestamp: Date.now(),
          payload: {
            file_id,
            chunkIndex,
            totalChunks,
            chunkHash,
            data: chunkBase64
          },
          nonce: null,
          mac_or_signature: null
        };

        // Gửi chunk và chờ ACK với cơ chế retry tối đa 3 lần
        let retries = 3;
        let acked = false;

        while (retries > 0 && !acked) {
          const chunkPromise = new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              pendingAcks.delete(chunkIndex);
              resolve(false);
            }, 5000);

            pendingAcks.set(chunkIndex, (ok) => {
              clearTimeout(timeout);
              resolve(ok);
            });
          });

          await this.channel.sendMessage(targetPeer.ip, targetPeer.tcpPort, chunkMsg);
          acked = await chunkPromise;

          if (!acked) {
            retries--;
            this.logger.warn("PROTOCOL", `Chunk ${chunkIndex + 1}/${totalChunks} chưa được ACK. Thử lại (còn ${retries} lần)...`);
          }
        }

        if (!acked) {
          throw new Error(`Gửi chunk ${chunkIndex + 1}/${totalChunks} thất bại sau 3 lần thử.`);
        }

        // Báo tiến độ gửi
        const transferredChunks = chunkIndex + 1;
        const percent = Math.floor((transferredChunks / totalChunks) * 100);
        if (onProgress) {
          onProgress({
            file_id,
            fileName,
            fileSize,
            totalChunks,
            transferredChunks,
            percent,
            direction: "out",
            status: transferredChunks === totalChunks ? "completed" : "transferring"
          });
        }
      }

      this.logger.info("NETWORK", `Gửi file '${fileName}' (${file_id}) thành công 100%!`);
      return { file_id, success: true };
    } finally {
      fs.closeSync(fd);
      this.activeTransfers.delete(file_id);
    }
  }
}

