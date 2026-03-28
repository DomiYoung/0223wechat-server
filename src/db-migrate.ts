/**
 * 迁移专用数据库连接池
 *
 * 设计意图：
 *   生产环境中，应用运行时的 DB 账号只应有 SELECT/INSERT/UPDATE/DELETE 权限。
 *   DDL 操作（CREATE TABLE / ALTER TABLE / CREATE INDEX 等）使用独立的迁移账号执行。
 *
 * 配置：
 *   - 如果配置了 DB_MIGRATE_USER / DB_MIGRATE_PASSWORD，使用迁移专用账号
 *   - 否则回退到与应用相同的 DB_USER / DB_PASSWORD（兼容开发环境）
 *
 * 使用场景：
 *   - scripts/init-db.ts
 *   - scripts/db_migrate_*.ts
 *   - 任何需要 DDL 权限的脚本
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const migrateUser = process.env.DB_MIGRATE_USER || process.env.DB_USER || 'root';
const migratePassword = process.env.DB_MIGRATE_PASSWORD || process.env.DB_PASSWORD || '';

export const migratePool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: migrateUser,
  password: migratePassword,
  database: process.env.DB_NAME || 'wedding_cms',
  waitForConnections: true,
  connectionLimit: 3,  // 迁移不需要高并发
  queueLimit: 0,
  charset: 'utf8mb4',
});

/**
 * 关闭迁移连接池（脚本执行完毕后调用）
 */
export async function closeMigratePool(): Promise<void> {
  await migratePool.end();
}
