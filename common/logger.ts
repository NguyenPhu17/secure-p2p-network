/**
 * Structured Logger cho Hệ thống Phân tán P2P
 * Hỗ trợ: Ghi console, Stream ghi file đĩa, Ring buffer bounded trong RAM (Tối ưu RAM)
 * và broadcast sự kiện log lên React UI qua callback.
 */

import fs from "node:fs";
import path from "node:path";

export interface LogEntry {
  id: string;
  timestamp: number;
  timeStr: string;
  level: "INFO" | "WARN" | "ERROR" | "DEBUG";
  category: "PROTOCOL" | "NETWORK" | "STORAGE" | "SYSTEM" | "DHT" | "ROUTING";
  direction?: "IN" | "OUT" | "INTERNAL";
  messageType?: string;
  peer?: string;
  summary: string;
  details?: any;
}

export class Logger {
  private logFilePath: string | null = null;
  private logFd: number | null = null;
  private maxFileSizeBytes = 10 * 1024 * 1024;
  private maxRotatedFiles = 3;
  private currentFileSizeBytes = 0;
  private isRotating = false;
  private ringBuffer: LogEntry[] = [];
  private maxEntries: number;
  private listeners: ((entry: LogEntry) => void)[] = [];

  constructor(private contextName: string, maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  /**
   * Kích hoạt ghi log ra file đĩa kèm xoay vòng theo dung lượng (mặc định 10MB x 3 file)
   */
  public enableFileLogging(
    logDir = "logs",
    maxFileSizeBytes = 10 * 1024 * 1024,
    maxRotatedFiles = 3
  ): void {
    try {
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      this.maxFileSizeBytes = maxFileSizeBytes;
      this.maxRotatedFiles = maxRotatedFiles;
      this.logFilePath = path.join(logDir, `${this.contextName}.log`);
      this.openLogStream();
    } catch (err: any) {
      console.error(`[${this.contextName}] File logging disabled: ${err.message}`);
      this.logFd = null;
    }
  }

  private openLogStream(): void {
    if (!this.logFilePath) return;
    try {
      this.logFd = fs.openSync(this.logFilePath, "a");
      this.currentFileSizeBytes = fs.fstatSync(this.logFd).size;
    } catch (err: any) {
      console.error(`[${this.contextName}] File logging disabled due to open error: ${err.message}`);
      this.logFd = null;
      this.currentFileSizeBytes = 0;
    }
  }

  private closeLogFd(): void {
    if (this.logFd !== null) {
      try {
        fs.closeSync(this.logFd);
      } catch {}
      this.logFd = null;
    }
  }

  private rotateLogFile(): void {
    if (!this.logFilePath || this.isRotating) return;
    this.isRotating = true;
    try {
      this.closeLogFd();
      for (let i = this.maxRotatedFiles - 1; i >= 1; i--) {
        const src = `${this.logFilePath}.${i}`;
        const dest = `${this.logFilePath}.${i + 1}`;
        if (fs.existsSync(src)) {
          fs.renameSync(src, dest);
        }
      }
      if (fs.existsSync(this.logFilePath)) {
        fs.renameSync(this.logFilePath, `${this.logFilePath}.1`);
      }
      this.openLogStream();
    } catch (err: any) {
      console.error(`[${this.contextName}] Failed to rotate log file: ${err.message}`);
    } finally {
      this.isRotating = false;
    }
  }

  /**
   * Đăng ký listener để nhận log real-time (phục vụ đẩy WebSocket lên UI)
   */
  public onLog(listener: (entry: LogEntry) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Ghi log cấu trúc
   */
  public log(entryInput: Omit<LogEntry, "id" | "timestamp" | "timeStr">): LogEntry {
    const now = new Date();
    const entry: LogEntry = {
      id: `${now.getTime()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: now.getTime(),
      timeStr: now.toISOString().replace("T", " ").substring(0, 19),
      ...entryInput
    };

    // 1. Tối ưu RAM: Ring buffer duy trì tối đa maxEntries nhưng bảo toàn các gói tin quan trọng (không để Heartbeat hoặc lỗi ping lặp lại đẩy trôi DHT/Protocol logs)
    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > Math.max(this.maxEntries, 300)) {
      const heartbeats: LogEntry[] = [];
      const noisyNetworkWarnings: LogEntry[] = [];
      const important: LogEntry[] = [];
      for (const item of this.ringBuffer) {
        const type = (item.messageType || "").toUpperCase();
        const sum = (item.summary || "").toUpperCase();
        if (type.includes("HEARTBEAT") || sum.includes("HEARTBEAT")) {
          heartbeats.push(item);
        } else if (
          item.category === "NETWORK" &&
          item.level === "WARN" &&
          sum.includes("KHÔNG THỂ KẾT NỐI TCP")
        ) {
          noisyNetworkWarnings.push(item);
        } else {
          important.push(item);
        }
      }
      this.ringBuffer = [
        ...important.slice(-250),
        ...noisyNetworkWarnings.slice(-40),
        ...heartbeats.slice(-10)
      ].sort((a, b) => a.timestamp - b.timestamp);
    }

    // 2. Ghi ra console
    const dirTag = entry.direction ? `[${entry.direction}]` : "";
    const typeTag = entry.messageType ? `[${entry.messageType}]` : "";
    const peerTag = entry.peer ? `(@${entry.peer})` : "";
    console.log(
      `[${entry.timeStr}] [${this.contextName}] [${entry.level}] [${entry.category}] ${dirTag}${typeTag}${peerTag} ${entry.summary}`
    );

    // 3. Ghi ra file nếu kích hoạt (kèm xoay vòng khi vượt quá ngưỡng)
    if (this.logFd !== null) {
      try {
        const line = JSON.stringify(entry) + "\n";
        const bytes = fs.writeSync(this.logFd, line, null, "utf8");
        this.currentFileSizeBytes += bytes;
        if (this.currentFileSizeBytes >= this.maxFileSizeBytes) {
          this.rotateLogFile();
        }
      } catch (err: any) {
        console.error(`[${this.contextName}] File logging write error: ${err.message}`);
        this.closeLogFd();
      }
    }

    // 4. Phát sự kiện cho listeners (WebSocket bridge)
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (e) {
        // Tránh lỗi listener làm ảnh hưởng luồng log
      }
    }

    return entry;
  }

  public info(category: LogEntry["category"], summary: string, details?: any, meta?: Partial<LogEntry>): LogEntry {
    return this.log({ level: "INFO", category, summary, details, ...meta });
  }

  public warn(category: LogEntry["category"], summary: string, details?: any, meta?: Partial<LogEntry>): LogEntry {
    return this.log({ level: "WARN", category, summary, details, ...meta });
  }

  public error(category: LogEntry["category"], summary: string, details?: any, meta?: Partial<LogEntry>): LogEntry {
    return this.log({ level: "ERROR", category, summary, details, ...meta });
  }

  public getRecentLogs(): LogEntry[] {
    return [...this.ringBuffer];
  }

  public close(): void {
    this.closeLogFd();
    this.ringBuffer = [];
    this.listeners = [];
  }
}

