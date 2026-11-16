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
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    max: number; // pool size
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
  },
  database: {
    host: "127.0.0.1",
    port: 5432,
    database: "p2p_network",
    user: "p2p_user",
    password: "p2p_pass",
    max: 10
  }
};

export function loadConfig(): SystemConfig {
  const candidatePaths = [
    path.resolve(__dirname, "../config.json"),
    path.resolve(process.cwd(), "config.json"),
    path.resolve(__dirname, "../../config.json")
  ];
  const configPath = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
  let cfg = { ...defaultConfig };

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      cfg = {
        registry: { ...defaultConfig.registry, ...parsed.registry },
        peer: { ...defaultConfig.peer, ...parsed.peer },
        database: { ...defaultConfig.database, ...parsed.database }
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

  // Ghi đè cấu hình database từ biến môi trường (nếu có)
  if (process.env.DB_HOST) {
    cfg.database.host = process.env.DB_HOST;
  }
  if (process.env.DB_PORT) {
    cfg.database.port = parseInt(process.env.DB_PORT, 10);
  }
  if (process.env.DB_NAME) {
    cfg.database.database = process.env.DB_NAME;
  }
  if (process.env.DB_USER) {
    cfg.database.user = process.env.DB_USER;
  }
  if (process.env.DB_PASSWORD) {
    cfg.database.password = process.env.DB_PASSWORD;
  }
  if (process.env.DB_MAX_POOL) {
    cfg.database.max = parseInt(process.env.DB_MAX_POOL, 10);
  }

  return cfg;
}

export const config = loadConfig();
