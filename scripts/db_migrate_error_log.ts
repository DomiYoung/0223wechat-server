/**
 * 迁移脚本：创建 app_error_log 表
 *
 * 使用 DDL 专用连接池。
 * 运行：npx tsx scripts/db_migrate_error_log.ts
 */
import 'dotenv/config';
import { migratePool, closeMigratePool } from '../src/db-migrate.js';
import { appLogger } from '../src/logger.js';

const log = appLogger.child({ module: 'migrate:error-log' });

async function migrate() {
    log.info('开始创建 app_error_log 表...');

    await migratePool.execute(`
        CREATE TABLE IF NOT EXISTS app_error_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            level VARCHAR(10) NOT NULL DEFAULT 'error' COMMENT '日志级别: warn/error/fatal',
            module VARCHAR(50) DEFAULT '' COMMENT '来源模块',
            message VARCHAR(500) DEFAULT '' COMMENT '日志消息(截断)',
            error_stack TEXT COMMENT '错误堆栈',
            request_id VARCHAR(64) DEFAULT '' COMMENT '请求追踪ID',
            method VARCHAR(10) DEFAULT '' COMMENT 'HTTP方法',
            path VARCHAR(255) DEFAULT '' COMMENT '请求路径',
            extra_meta JSON COMMENT '额外上下文信息',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_level_created (level, created_at DESC),
            INDEX idx_module_created (module, created_at DESC),
            INDEX idx_created (created_at DESC),
            INDEX idx_request_id (request_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='应用错误日志(warn/error/fatal)'
    `);

    log.info('app_error_log 表创建完成');
    await closeMigratePool();
}

migrate()
    .then(() => process.exit(0))
    .catch(async (err) => {
        log.error({ err }, 'app_error_log 迁移失败');
        await closeMigratePool().catch(() => {});
        process.exit(1);
    });
