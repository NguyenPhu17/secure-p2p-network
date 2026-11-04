/**
 * FileReceiver - Quản lý việc tiếp nhận các chunk 64KB từ bên gửi, ghi trực tiếp xuống đĩa và kiểm tra tính toàn vẹn
 * Tối ưu RAM: Ghi trực tiếp xuống file tạm trên đĩa, không tích lũy dữ liệu chunk trong bộ nhớ.
 *
 * TODO(SECURITY): Xác thực chữ ký số và giải mã từng chunk / toàn file ở Giai đoạn 2.
 */

import fs from "node:fs";
import path from "node:path";
import { IChannel } from "../../common/channel.js";
import {
  BaseMessage,
  MessageType,
  FileMetaPayload,
  FileChunkPayload,
  FileAckPayload,
  PeerInfo
} from "../../common/protocol.js";
import { calculateChecksum, calculateFileChecksum } from "../../common/checksum.js";
import { Logger } from "../../common/logger.js";
import { FileTransferProgress } from "./file-sender.js";

interface IncomingTransfer {
  file_id: string;
  sender: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  expectedFileHash: string;
  tempPath: string;
  fd: number;
  receivedChunks: Set<number>;
}

export class FileReceiver {
  private activeTransfers: Map<string, IncomingTransfer> = new Map();
  private downloadDir: string;

  constructor(
    private channel: IChannel,
    private myName: string,
    private logger: Logger,
    customDownloadDir?: string
  ) {
    this.downloadDir = customDownloadDir || path.resolve("downloads", this.myName);
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  /**
   * Xử lý gói tin FILE_META từ peer gửi
   */
  public handleFileMeta(
    msg: BaseMessage<FileMetaPayload>,
    onProgress?: (progress: FileTransferProgress) => void
  ): void {
    const payload = msg.payload;
    const tempPath = path.join(this.downloadDir, `${payload.file_id}.tmp`);
    const fd = fs.openSync(tempPath, "w");

    const transfer: IncomingTransfer = {
      file_id: payload.file_id,
      sender: msg.sender,
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      chunkSize: payload.chunkSize,
      totalChunks: payload.totalChunks,
      expectedFileHash: payload.fileHash,
      tempPath,
      fd,
      receivedChunks: new Set()
    };

    this.activeTransfers.set(payload.file_id, transfer);
    this.logger.info(
      "NETWORK",
      `Bắt đầu nhận file '${payload.fileName}' (${payload.fileSize} bytes, ${payload.totalChunks} chunks) từ '${msg.sender}'`
    );

    if (onProgress) {
      onProgress({
        file_id: payload.file_id,
        fileName: payload.fileName,
        fileSize: payload.fileSize,
        totalChunks: payload.totalChunks,
        transferredChunks: 0,
        percent: 0,
        direction: "in",
        status: "transferring"
      });
    }
  }

  /**
   * Xử lý gói tin FILE_CHUNK từ peer gửi
   */
  public async handleFileChunk(
    msg: BaseMessage<FileChunkPayload>,
    senderPeerInfo: PeerInfo | undefined,
    onProgress?: (progress: FileTransferProgress) => void,
    onComplete?: (result: { file_id: string; fileName: string; localPath: string; size: number; hash: string }) => void
  ): Promise<void> {
    const payload = msg.payload;
    const transfer = this.activeTransfers.get(payload.file_id);

    if (!transfer) {
      this.logger.warn("PROTOCOL", `Nhận chunk cho file không tồn tại hoặc đã hủy: ${payload.file_id}`);
      return;
    }

    const chunkBuffer = Buffer.from(payload.data, "base64");

    // 1. Kiểm tra tính toàn vẹn của chunk (Checksum)
    // TODO(SECURITY): Xác thực MAC / Chữ ký số của chunk
    const calculatedHash = calculateChecksum(chunkBuffer);
    if (calculatedHash !== payload.chunkHash) {
      this.logger.error(
        "PROTOCOL",
        `Sai lệch checksum chunk ${payload.chunkIndex} của file ${payload.file_id}: ${calculatedHash} !== ${payload.chunkHash}`
      );
      await this.sendFileAck(senderPeerInfo, payload.file_id, payload.chunkIndex, "RETRY");
      return;
    }

    // 2. Ghi trực tiếp xuống đĩa tại offset tương ứng (Tối ưu RAM)
    const offset = payload.chunkIndex * transfer.chunkSize;
    fs.writeSync(transfer.fd, chunkBuffer, 0, chunkBuffer.length, offset);
    transfer.receivedChunks.add(payload.chunkIndex);

    // 3. Gửi FILE_ACK xác nhận nhận thành công chunk
    await this.sendFileAck(senderPeerInfo, payload.file_id, payload.chunkIndex, "OK");

    const transferredChunks = transfer.receivedChunks.size;
    const percent = Math.floor((transferredChunks / transfer.totalChunks) * 100);

    if (onProgress) {
      onProgress({
        file_id: transfer.file_id,
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        totalChunks: transfer.totalChunks,
        transferredChunks,
        percent,
        direction: "in",
        status: transferredChunks === transfer.totalChunks ? "completed" : "transferring"
      });
    }

    // 4. Nếu đã nhận đủ toàn bộ các chunks -> Xác thực hash toàn file và lưu trữ
    if (transferredChunks === transfer.totalChunks) {
      fs.closeSync(transfer.fd);

      // Tính checksum toàn file từ đĩa
      const actualFileHash = await calculateFileChecksum(transfer.tempPath);
      if (actualFileHash !== transfer.expectedFileHash) {
        this.logger.error(
          "PROTOCOL",
          `LỖI TOÀN VẸN FILE: Hash toàn file không khớp! (Tính được: ${actualFileHash}, Kỳ vọng: ${transfer.expectedFileHash})`
        );
        fs.unlinkSync(transfer.tempPath);
        this.activeTransfers.delete(transfer.file_id);
        throw new Error(`FILE_HASH_MISMATCH: ${actualFileHash} !== ${transfer.expectedFileHash}`);
      }

      // Đổi tên file tạm thành tên file chính thức
      let finalPath = path.join(this.downloadDir, transfer.fileName);
      if (fs.existsSync(finalPath)) {
        const ext = path.extname(transfer.fileName);
        const base = path.basename(transfer.fileName, ext);
        finalPath = path.join(this.downloadDir, `${base}_${Date.now()}${ext}`);
      }

      fs.renameSync(transfer.tempPath, finalPath);
      this.logger.info("SYSTEM", `Nhận file '${transfer.fileName}' thành công và lưu tại: ${finalPath}`);

      this.activeTransfers.delete(transfer.file_id);

      if (onComplete) {
        onComplete({
          file_id: transfer.file_id,
          fileName: transfer.fileName,
          localPath: finalPath,
          size: transfer.fileSize,
          hash: actualFileHash
        });
      }
    }
  }

  private async sendFileAck(
    senderPeerInfo: PeerInfo | undefined,
    file_id: string,
    chunkIndex: number,
    status: "OK" | "RETRY"
  ): Promise<void> {
    if (!senderPeerInfo) return;

    const ackMsg: BaseMessage<FileAckPayload> = {
      type: MessageType.FILE_ACK,
      message_id: crypto.randomUUID(),
      sender: this.myName,
      receiver: senderPeerInfo.displayName,
      seq: chunkIndex,
      timestamp: Date.now(),
      payload: {
        file_id,
        chunkIndex,
        status
      },
      nonce: null,
      mac_or_signature: null
    };

    await this.channel.sendMessage(senderPeerInfo.ip, senderPeerInfo.tcpPort, ackMsg);
  }
}

