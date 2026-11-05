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
  private logStream: fs.WriteStream | null = null;
  private ringBuffer: LogEntry[] = [];
  private maxEntries: number;
  private listeners: ((entry: LogEntry) => void)[] = [];

  constructor(private contextName: string, maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  /**
   * Kích hoạt ghi log ra file đĩa
   */
  public enableFileLogging(logDir = "logs"): void {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.logFilePath = path.join(logDir, `${this.contextName}.log`);
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: "a" });
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

    // 1. Tối ưu RAM: Ring buffer duy trì tối đa maxEntries nhưng bảo toàn các gói tin quan trọng (không để Heartbeat đẩy trôi)
    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > Math.max(this.maxEntries, 300)) {
      const heartbeats: LogEntry[] = [];
      const important: LogEntry[] = [];
      for (const item of this.ringBuffer) {
        const type = (item.messageType || "").toUpperCase();
        const sum = (item.summary || "").toUpperCase();
        if (type.includes("HEARTBEAT") || sum.includes("HEARTBEAT")) {
          heartbeats.push(item);
        } else {
          important.push(item);
        }
      }
      this.ringBuffer = [...important.slice(-290), ...heartbeats.slice(-10)].sort(
        (a, b) => a.timestamp - b.timestamp
      );
    }

    // 2. Ghi ra console
    const dirTag = entry.direction ? `[${entry.direction}]` : "";
    const typeTag = entry.messageType ? `[${entry.messageType}]` : "";
    const peerTag = entry.peer ? `(@${entry.peer})` : "";
    console.log(
      `[${entry.timeStr}] [${this.contextName}] [${entry.level}] [${entry.category}] ${dirTag}${typeTag}${peerTag} ${entry.summary}`
    );

    // 3. Ghi ra stream file nếu kích hoạt
    if (this.logStream) {
      this.logStream.write(JSON.stringify(entry) + "\n");
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
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
    this.ringBuffer = [];
    this.listeners = [];
  }
}

