import 'dotenv/config';
import { ensureReservationMobileUnique } from '../src/db.js';

async function main() {
  await ensureReservationMobileUnique();
  console.log('[MIGRATE] reservation.mobile unique ensured');
}

main().catch((err) => {
  console.error('[MIGRATE] failed:', err);
  process.exit(1);
});
