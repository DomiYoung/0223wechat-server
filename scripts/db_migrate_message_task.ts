/**
 * 迁移脚本：创建 message_task 和 message_send_log 表
 *
 * 使用 DDL 专用连接池。
 * 运行：npx tsx scripts/db_migrate_message_task.ts
 */
import 'dotenv/config';
import { migratePool, closeMigratePool } from '../src/db-migrate.js';
import { appLogger } from '../src/logger.js';
import { ensureMessageTaskTables } from '../src/db-admin.js';

const log = appLogger.child({ module: 'migrate:message-task' });

async function migrate() {
    log.info('开始创建消息任务相关表...');

    try {
        await ensureMessageTaskTables(migratePool as any);
        log.info('消息任务相关表创建完成');
    } catch (err) {
        log.error({ err }, '消息任务相关表创建失败');
        throw err;
    } finally {
        await closeMigratePool();
    }
}

migrate()
    .then(() => process.exit(0))
    .catch((err) => {
        process.exit(1);
    });
