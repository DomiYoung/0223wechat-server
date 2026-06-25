/**
 * 迁移脚本：补齐线上性能索引
 *
 * 运行：
 *   npx tsx scripts/db_migrate_perf_indexes.ts
 */
import 'dotenv/config';
import { migratePool, closeMigratePool } from '../src/db-migrate.js';
import { appLogger } from '../src/logger.js';

const log = appLogger.child({ module: 'script:migrate-perf-indexes' });

const INDEX_STATEMENTS = [
  {
    label: 'wedding_case.idx_active_sort_id',
    sql: 'CREATE INDEX idx_active_sort_id ON wedding_case(is_active, sort_order, id)',
  },
  {
    label: 'wedding_case.idx_active_category',
    sql: 'CREATE INDEX idx_active_category ON wedding_case(is_active, category_id)',
  },
  {
    label: 'wedding_case.idx_active_category_sort_id',
    sql: 'CREATE INDEX idx_active_category_sort_id ON wedding_case(is_active, category_id, sort_order, id)',
  },
  {
    label: 'wedding_case.idx_venue_featured_active_sort',
    sql: 'CREATE INDEX idx_venue_featured_active_sort ON wedding_case(venue_id, is_featured, is_active, sort_order, id)',
  },
  {
    label: 'package.idx_category_active_sort',
    sql: 'CREATE INDEX idx_category_active_sort ON package(category_id, is_active, sort_order, id)',
  },
  {
    label: 'package.idx_active_sort_id',
    sql: 'CREATE INDEX idx_active_sort_id ON package(is_active, sort_order, id)',
  },
  {
    label: 'venue.idx_brand_active_id',
    sql: 'CREATE INDEX idx_brand_active_id ON venue(brand_id, is_active, id)',
  },
  {
    label: 'venue.idx_active_brand_id',
    sql: 'CREATE INDEX idx_active_brand_id ON venue(is_active, brand_id, id)',
  },
];

async function ensureIndex(label: string, sql: string) {
  try {
    await migratePool.execute(sql);
    log.info({ label }, 'performance index created');
  } catch (err: any) {
    if (err?.code === 'ER_DUP_KEYNAME' || err?.errno === 1061) {
      log.info({ label }, 'performance index already exists');
      return;
    }
    throw err;
  }
}

async function main() {
  for (const item of INDEX_STATEMENTS) {
    await ensureIndex(item.label, item.sql);
  }

  await migratePool.query('ANALYZE TABLE wedding_case, package, venue, case_image, package_image, venue_image');
  log.info('performance indexes migration completed');
  await closeMigratePool();
  process.exit(0);
}

main().catch(async (err) => {
  log.error({ err }, 'performance index migration failed');
  await closeMigratePool().catch(() => {});
  process.exit(1);
});
