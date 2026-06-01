/**
 * 婚嫁小程序图片更新脚本 (ESM)
 */
import OSS from 'ali-oss';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = '/tmp/wedding_update/5.31小程序修改';
const UPLOAD_PREFIX = 'wechat-miniprogram/assets/2026-06';

const OSS_CONFIG = {
  region: 'oss-cn-shanghai',
  bucket: 'creativepro',
  accessKeyId: 'LTAI5tBT69u3wuJPGSqJ3vk6',
  accessKeySecret: fs.readFileSync('/tmp/oss_secret.txt', 'utf8').trim(),
};

const DB_CONFIG = {
  host: '47.99.143.156',
  port: 3306,
  user: 'root',
  password: fs.readFileSync('/tmp/db_pass.txt', 'utf8').trim(),
  database: 'wedding',
};

function rand4() { return Math.random().toString(36).slice(2, 6); }
function genObjectName(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  return `${UPLOAD_PREFIX}/${Date.now()}-${rand4()}-${base}${ext}`;
}

const mappings = [
  { table: 'venue_image', local: '旗舰店最上方轮播图', files: ['1.jpg','2.jpg','3.jpg','4.jpg','5.jpg'], keyCol: 'venue_id', keyVal: 1 },
  { table: 'case_image', local: '屋顶花园', files: ['详情1.mp4','详情2.jpg'], keyCol: 'case_id', keyVal: 1 },
  { table: 'case_image', local: '户外花园', files: ['详情1.mp4','详情2.jpg','详情3.jpg'], keyCol: 'case_id', keyVal: 2 },
  { table: 'case_image', local: '爱恋浓', files: ['详情1.mp4','详情2.jpg','详情3.jpg','详情4.jpg','详情5.jpg'], keyCol: 'case_id', keyVal: 5 },
  { table: 'case_image', local: '百花时', files: ['详情1.mp4','详情2.jpg','详情3.jpg','详情4.jpg','详情5.jpg'], keyCol: 'case_id', keyVal: 6 },
  { table: 'wedding_case', local: '屋顶花园', files: ['封面图.jpg'], keyCol: 'id', keyVal: 1, isCover: true },
  { table: 'wedding_case', local: '户外花园', files: ['封面图.jpg'], keyCol: 'id', keyVal: 2, isCover: true },
  { table: 'wedding_case', local: '爱恋浓', files: ['封面图.jpg'], keyCol: 'id', keyVal: 5, isCover: true },
  { table: 'wedding_case', local: '百花时', files: ['封面图.jpg'], keyCol: 'id', keyVal: 6, isCover: true },
  { table: 'package_image', local: '生日宴/3980元', files: ['详情1.jpg','详情2.jpg','详情3.jpg'], keyCol: 'package_id', keyVal: 16 },
  { table: 'package', local: '生日宴/3980元', files: ['封面.png'], keyCol: 'id', keyVal: 16, isCover: true },
  { table: 'venue', local: '门店', files: ['旗舰店.jpg'], keyCol: 'id', keyVal: 1, isCover: true },
];

async function main() {
  const client = new OSS(OSS_CONFIG);
  const pool = mysql.createPool(DB_CONFIG);
  const conn = await pool.getConnection();
  console.log('✅ OSS + DB connected');

  try {
    await conn.beginTransaction();
    let uploaded = 0;

    for (const m of mappings) {
      const dir = path.join(BASE_DIR, m.local);
      process.stdout.write(`\n📁 ${m.local}: `);
      
      for (let i = 0; i < m.files.length; i++) {
        const file = m.files[i];
        const filePath = path.join(dir, file);
        
        if (!fs.existsSync(filePath)) {
          console.error(`\n  ❌ MISSING: ${filePath}`);
          continue;
        }

        const objectName = genObjectName(file);
        const result = await client.put(objectName, filePath);
        const url = result.url;
        uploaded++;
        process.stdout.write('✓');

        if (m.isCover) {
          await conn.query(`UPDATE ${m.table} SET cover_url = ? WHERE ${m.keyCol} = ?`, [url, m.keyVal]);
        } else {
          await conn.query(`UPDATE ${m.table} SET is_active = 0 WHERE ${m.keyCol} = ? AND is_active = 1`, [m.keyVal]);
          await conn.query(`INSERT INTO ${m.table} (${m.keyCol}, image_url, sort_order, is_active) VALUES (?, ?, ?, 1)`, [m.keyVal, url, i]);
        }
      }
    }

    await conn.commit();
    console.log(`\n\n✅ DONE — ${uploaded} files uploaded, DB updated.`);
  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
    await conn.rollback();
    process.exit(1);
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });