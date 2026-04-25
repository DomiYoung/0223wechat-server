import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load env vars
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.resolve(__dirname, '../.env') });

import pool from '../src/db.js';
import AdmZip from 'adm-zip';
import { processBulkUpload } from '../src/services/bulk-upload.service.js';
import { appLogger } from '../src/logger.js';

async function main() {
  console.log('Starting migration for 枫汀南...');

  // 1. Find 漕河泾臻选店 ID
  const [venueRows] = await pool.query("SELECT id FROM venue WHERE name LIKE '%漕河泾%'") as any;
  if (!venueRows.length) {
    throw new Error("Venue 漕河泾臻选店 not found");
  }
  const venueId = venueRows[0].id;
  console.log(`Found venue ID: ${venueId}`);

  // 2. Delete old 枫汀南 cases
  const [oldCases] = await pool.query("SELECT id FROM wedding_case WHERE venue_id = ? AND hall_name LIKE '%枫汀南%'", [venueId]) as any;
  if (oldCases.length > 0) {
    const ids = oldCases.map((r: any) => r.id);
    console.log(`Deleting old cases with IDs: ${ids.join(',')}`);
    await pool.query(`DELETE FROM case_image WHERE case_id IN (${ids.join(',')})`);
    await pool.query(`DELETE FROM wedding_case WHERE id IN (${ids.join(',')})`);
  }

  // 3. Create 3 new records
  const halls = ['枫汀南 蓝汀序章', '枫汀南 莫奈花园', '枫汀南 梦幻宫殿'];
  for (const hall of halls) {
    console.log(`Creating new hall: ${hall}`);
    await pool.query(
      `INSERT INTO wedding_case (title, hall_name, venue_id, is_featured, is_active, sort_order) VALUES (?, ?, ?, 1, 1, 0)`,
      [hall, hall, venueId]
    );
  }

  // 4. Zip the unzipped folders with the expected structure and upload
  const zip = new AdmZip();
  const baseDir = '/Users/jinjia/projects/代码项目/0223wechat-admin/assets_unzipped/漕河泾臻选店';
  
  console.log('Adding local folders to zip...');
  zip.addLocalFolder(`${baseDir}/枫汀南（上传1）`, `小程序素材/漕河泾臻选店/婚礼主题/枫汀南 蓝汀序章`);
  zip.addLocalFolder(`${baseDir}/枫汀南（上传2）`, `小程序素材/漕河泾臻选店/婚礼主题/枫汀南 莫奈花园`);
  zip.addLocalFolder(`${baseDir}/枫汀南（上传3）`, `小程序素材/漕河泾臻选店/婚礼主题/枫汀南 梦幻宫殿`);

  console.log("Processing bulk upload...");
  const report = await processBulkUpload(zip.toBuffer());
  console.log("Upload report:", report);
  
  console.log("Migration completed successfully.");
  process.exit(0);
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
