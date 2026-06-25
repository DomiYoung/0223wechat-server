/**
 * 数据库迁移：为 wx_user 表添加持久化 token 相关字段
 * 解决用户每次刷新小程序都被踢出登录的问题
 * 
 * 执行方式：npx tsx scripts/db_migrate_wx_user_token.ts
 */
import { createPool } from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const pool = createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'wedding',
});

async function migrate() {
  const conn = await pool.getConnection();
  try {
    console.log('[migrate] 开始为 wx_user 表添加 token 字段...');

    // 检查 token 列是否存在
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'wx_user' 
         AND COLUMN_NAME IN ('token', 'token_expires_at')`
    ) as any[];

    const existingCols = (cols as any[]).map((c: any) => c.COLUMN_NAME);

    if (!existingCols.includes('token')) {
      await conn.execute(
        `ALTER TABLE wx_user ADD COLUMN token VARCHAR(64) DEFAULT NULL COMMENT '自签持久化登录态 token(30天有效)'`
      );
      console.log('[migrate] ✅ 已添加 token 字段');
    } else {
      console.log('[migrate] ⏭  token 字段已存在，跳过');
    }

    if (!existingCols.includes('token_expires_at')) {
      await conn.execute(
        `ALTER TABLE wx_user ADD COLUMN token_expires_at DATETIME DEFAULT NULL COMMENT 'token 过期时间'`
      );
      console.log('[migrate] ✅ 已添加 token_expires_at 字段');
    } else {
      console.log('[migrate] ⏭  token_expires_at 字段已存在，跳过');
    }

    // 为 token 列建索引（用于服务端鉴权查询）
    try {
      await conn.execute(
        `ALTER TABLE wx_user ADD INDEX idx_wx_user_token (token)`
      );
      console.log('[migrate] ✅ 已建立 token 索引');
    } catch (e: any) {
      if (e.code === 'ER_DUP_KEYNAME') {
        console.log('[migrate] ⏭  token 索引已存在，跳过');
      } else {
        throw e;
      }
    }

    console.log('[migrate] 🎉 迁移完成！');
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('[migrate] 迁移失败:', err);
  process.exit(1);
});
