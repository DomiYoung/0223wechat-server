/**
 * 数据库初始化脚本
 *
 * 使用 DDL 专用连接池执行建表和迁移操作。
 * 生产环境请配置 DB_MIGRATE_USER / DB_MIGRATE_PASSWORD 使用有 DDL 权限的账号。
 *
 * 运行：npx tsx scripts/init-db.ts
 */
import { initDB } from '../src/db-admin.js';
import { migratePool, closeMigratePool } from '../src/db-migrate.js';
import { appLogger } from '../src/logger.js';

const log = appLogger.child({ module: 'script:init-db' });

initDB(migratePool)
  .then(async () => {
    log.info('db init done');
    await closeMigratePool();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error({ err }, 'db init failed');
    await closeMigratePool().catch(() => {});
    process.exit(1);
  });
