import 'dotenv/config';
import { ensureCoreForeignKeys, ensureUserSubscribeUniqueByBizType } from '../src/db.js';

async function main() {
  await ensureUserSubscribeUniqueByBizType();
  await ensureCoreForeignKeys();
  console.log('[MIGRATE] core schema constraints ensured');
}

main().catch((err) => {
  console.error('[MIGRATE] failed:', err);
  process.exit(1);
});
