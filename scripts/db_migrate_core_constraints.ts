/**
 * 迁移脚本：核心约束 — 外键清理、订阅去重、消息任务表
 *
 * 使用 DDL 专用连接池。
 * 运行：npx tsx scripts/db_migrate_core_constraints.ts
 */
import 'dotenv/config';
import { cleanupCoreRelationRefs, dropLegacyForeignKeys, ensureMessageTaskTables, ensureUserSubscribeUniqueByBizType } from '../src/db-admin.js';
import { migratePool, closeMigratePool } from '../src/db-migrate.js';
import { appLogger } from '../src/logger.js';

const log = appLogger.child({ module: 'script:migrate-core' });

async function main() {
  await ensureMessageTaskTables(migratePool);
  await ensureUserSubscribeUniqueByBizType();
  await cleanupCoreRelationRefs();
  await dropLegacyForeignKeys();
  log.info('core relation cleanup and foreign key removal completed');
  await closeMigratePool();
}

main().catch(async (err) => {
  log.error({ err }, 'core schema constraint migration failed');
  await closeMigratePool().catch(() => {});
  process.exit(1);
});
