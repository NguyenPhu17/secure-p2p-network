/**
 * Quản lý khởi tạo và kiểm tra Connection Pool PostgreSQL
 * Sử dụng thư viện 'pg' (node-postgres)
 */

import { Pool, PoolConfig } from "pg";
import { config } from "../../common/config.js";

/**
 * Tạo mới một pg.Pool dựa trên cấu hình config.json và biến môi trường
 */
export function createDatabasePool(override?: Partial<PoolConfig>): Pool {
  return new Pool({
    host: override?.host ?? process.env.DB_HOST ?? config.database.host,
    port: override?.port ?? (process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : config.database.port),
    database: override?.database ?? process.env.DB_NAME ?? config.database.database,
    user: override?.user ?? process.env.DB_USER ?? config.database.user,
    password: override?.password ?? process.env.DB_PASSWORD ?? config.database.password,
    max: override?.max ?? config.database.max,
    ...override
  });
}

/**
 * Kiểm tra kết nối tới cơ sở dữ liệu PostgreSQL
 */
export async function testDatabaseConnection(pool: Pool): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query("SELECT 1;");
    client.release();
    return true;
  } catch (err) {
    return false;
  }
}
