/**
 * 迁移脚本：reservation.mobile 唯一性约束
 *
 * 使用 DDL 专用连接池。
 * 运行：npx tsx scripts/db_migrate_reservation_unique.ts
 */
import 'dotenv/config';
import { ensureReservationMobileUnique } from '../src/db-admin.js';
import { closeMigratePool } from '../src/db-migrate.js';
import { appLogger } from '../src/logger.js';

const log = appLogger.child({ module: 'script:migrate-reservation-unique' });

async function main() {
  await ensureReservationMobileUnique();
  log.info('reservation.mobile unique ensured');
  await closeMigratePool();
}

main().catch(async (err) => {
  log.error({ err }, 'reservation.mobile unique migration failed');
  await closeMigratePool().catch(() => {});
  process.exit(1);
});
