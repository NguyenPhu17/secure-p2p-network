/**
 * Quản lý cấu hình tập trung cho toàn hệ thống
 * Đọc từ config.json và ghi đè từ biến môi trường (nếu có).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SystemConfig {
  registry: {
    host: string;
    port: number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    checkIntervalMs: number;
  };
  peer: {
    defaultChunkSize: number;
    reconnectIntervalMs: number;
    maxLogEntries: number;
  };
}

const defaultConfig: SystemConfig = {
  registry: {
    host: "127.0.0.1",
    port: 7000,
    heartbeatIntervalMs: 5000,
    heartbeatTimeoutMs: 15000,
    checkIntervalMs: 3000
  },
  peer: {
    defaultChunkSize: 65536, // 64 KB
    reconnectIntervalMs: 5000,
    maxLogEntries: 100 // Tối ưu RAM: Giới hạn tối đa 100 log trong memory
  }
};

export function loadConfig(): SystemConfig {
  const configPath = path.resolve(__dirname, "../../config.json");
  let cfg = { ...defaultConfig };

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      cfg = {
        registry: { ...defaultConfig.registry, ...parsed.registry },
        peer: { ...defaultConfig.peer, ...parsed.peer }
      };
    } catch (e) {
      console.warn("[Config] Failed to parse config.json, using defaults.", e);
    }
  }

  // Ghi đè bằng biến môi trường (nếu có)
  if (process.env.REGISTRY_HOST) {
    cfg.registry.host = process.env.REGISTRY_HOST;
  }
  if (process.env.REGISTRY_PORT) {
    cfg.registry.port = parseInt(process.env.REGISTRY_PORT, 10);
  }

  return cfg;
}

export const config = loadConfig();

