/**
 * 婚嫁小程序图片更新脚本 - 本地版
 * 本地直连 OSS 上传 → SSH 连 MySQL 更新 DB
 */
import OSS from 'ali-oss';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = '/tmp/wedding_update/5.31小程序修改';
const UPLOAD_PREFIX = 'wechat-miniprogram/assets/2026-06';

// OSS config — 本地直连
const OSS_CONFIG = {
  region: 'oss-cn-shanghai',
  bucket: 'creativepro',
  accessKeyId: 'LTAI5tBT69u3wuJPGSqJ3vk6',
  accessKeySecret: null, // filled below
};

// SSH config for DB updates
const SSH_HOST = '47.99.143.156';
const SSH_USER = 'root';
const SSH_PASS = '@Domi1688';

function rand4() { return Math.random().toString(36).slice(2, 6); }
function genObjectName(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  return `${UPLOAD_PREFIX}/${Date.now()}-${rand4()}-${base}${ext}`;
}

// Read secrets
function readSecret(name) {
  const result = spawnSync('python3', ['-c', `
with open('/Users/light/.hermes/envs/wedding/.env') as f:
    for line in f:
        if line.startswith('${name}='):
            print(line.strip().split('=',1)[1])
            break
  `], { encoding: 'utf8' });
  return result.stdout.trim();
}

function getDBPassword() {
  const result = spawnSync(
    'security', ['find-generic-password', '-s', 'domi-api-key-vault', '-a', 'api/wedding-mysql-47.99.143.156-root', '-w'],
    { encoding: 'utf8', env: { ...process.env, HOME: '/Users/light' } }
  );
  return result.stdout.trim();
}

function sql(cmd) {
  const pass = getDBPassword();
  const escaped = cmd.replace(/'/g, "'\\''");
  const result = spawnSync('sshpass', ['-p', SSH_PASS, 'ssh', '-o', 'StrictHostKeyChecking=no', `${SSH_USER}@${SSH_HOST}`,
    `mysql -u root -p'${pass}' wedding -e '${escaped}'`
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`SQL failed: ${result.stderr}`);
  }
  return result.stdout;
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
  // Get secrets
  OSS_CONFIG.accessKeySecret = readSecret('ALIYUN_OSS_ACCESS_KEY_SECRET');
  if (!OSS_CONFIG.accessKeySecret || OSS_CONFIG.accessKeySecret.length < 10) {
    console.error('ERROR: OSS secret not found or too short');
    process.exit(1);
  }
  console.log(`✅ OSS secret loaded (${OSS_CONFIG.accessKeySecret.length} chars)`);

  const dbPass = getDBPassword();
  console.log(`✅ DB password loaded (${dbPass.length} chars)`);

  const client = new OSS(OSS_CONFIG);
  console.log('✅ OSS connected');

  let uploaded = 0;
  let dbQueries = [];

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

      // Upload to OSS
      const objectName = genObjectName(file);
      const result = await client.put(objectName, filePath);
      const url = result.url;
      uploaded++;
      process.stdout.write('✓');

      // Build SQL
      if (m.isCover) {
        dbQueries.push(`UPDATE ${m.table} SET cover_url='${url}' WHERE ${m.keyCol}=${m.keyVal};`);
      } else {
        dbQueries.push(`UPDATE ${m.table} SET is_active=0 WHERE ${m.keyCol}=${m.keyVal} AND is_active=1;`);
        dbQueries.push(`INSERT INTO ${m.table} (${m.keyCol}, image_url, sort_order, is_active) VALUES (${m.keyVal}, '${url}', ${i}, 1);`);
      }
    }
  }

  console.log(`\n\n✅ ${uploaded} files uploaded to OSS`);
  console.log(`📝 ${dbQueries.length} SQL statements to execute\n`);

  // Execute SQL via SSH
  const pass = getDBPassword();
  const sqlScript = dbQueries.join('\n');
  const escaped = sqlScript.replace(/'/g, "'\\''");
  
  console.log('🔄 Updating database...');
  const result = spawnSync('sshpass', ['-p', SSH_PASS, 'ssh', '-o', 'StrictHostKeyChecking=no', `${SSH_USER}@${SSH_HOST}`,
    `mysql -u root -p'${pass}' wedding -e '${escaped}' 2>&1`
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  
  if (result.status === 0) {
    console.log('✅ Database updated successfully');
  } else {
    console.error('❌ DB update failed:', result.stderr);
  }

  // Clear cache
  console.log('\n🔄 Restarting PM2...');
  const restart = spawnSync('sshpass', ['-p', SSH_PASS, 'ssh', '-o', 'StrictHostKeyChecking=no', `${SSH_USER}@${SSH_HOST}`,
    'pm2 restart wechat-server'
  ], { encoding: 'utf8' });
  console.log(restart.stdout.trim());
  
  console.log('\n✅ DONE');
}

main().catch(e => { console.error(e); process.exit(1); });