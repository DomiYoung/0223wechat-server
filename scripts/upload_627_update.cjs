const { Client } = require('ssh2');
const net = require('net');
const mysql = require('mysql2/promise');
const OSS = require('ali-oss');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const sshConfig = {
  host: '47.99.143.156',
  port: 22,
  username: 'root',
  password: '@Domi1688'
};

const localPort = 3314;
const BASE_DIR = '/Users/jinjia/projects/代码项目/0305-project/tmp_unzip/6.27小程序修改';
const UPLOAD_PREFIX = 'wechat-miniprogram/assets/2026-06';

// OSS client config
const OSS_CONFIG = {
  region: process.env.ALIYUN_OSS_REGION || 'oss-cn-shanghai',
  bucket: process.env.ALIYUN_OSS_BUCKET || 'creativepro',
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
};

const mappings = [
  // 5）宴会套餐-婚庆套餐修改
  { folder: '婚庆套餐/79800', packageId: 11 },
  { folder: '婚庆套餐/89800', packageId: 12 },
  
  // 6）生日宴
  { folder: '生日宴/2980', packageId: 15 },
  { folder: '生日宴/3980', packageId: 16 },
  { folder: '生日宴/4980', packageId: 17 },

  // 7）商务宴请
  { folder: '商务宴请/1880', packageId: 1 },
  { folder: '商务宴请/2880', packageId: 2 },
  { folder: '商务宴请/3880', packageId: 3 },

  // 8）婚宴菜单修改
  { folder: '婚宴菜单/7980', packageId: 8 },
  { folder: '婚宴菜单/8980', packageId: 6 },
  { folder: '婚宴菜单/9980', packageId: 4 },
  { folder: '婚宴菜单/11980', packageId: 5 },
  { folder: '婚宴菜单/13980', packageId: 7 },
  { folder: '婚宴菜单/22980', packageId: 13 },
  { folder: '婚宴菜单/答谢宴&回门宴', packageId: 14 }
];

function rand4() { return Math.random().toString(36).slice(2, 6); }
function genObjectName(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  return `${UPLOAD_PREFIX}/${Date.now()}-${rand4()}-${base}${ext}`;
}

async function runUpload(conn) {
  const client = new OSS(OSS_CONFIG);
  console.log('✅ OSS Client Ready');

  let totalUploaded = 0;

  for (const m of mappings) {
    const dirPath = path.join(BASE_DIR, m.folder);
    if (!fs.existsSync(dirPath)) {
      console.error(`❌ Folder not found: ${dirPath}`);
      continue;
    }

    // Get all files in the folder, filtering out macOS metadata files (like ._*)
    const files = fs.readdirSync(dirPath)
      .filter(file => {
        const filePath = path.join(dirPath, file);
        const isFile = fs.statSync(filePath).isFile();
        return isFile && !file.startsWith('._') && !file.startsWith('.');
      })
      .sort((a, b) => {
        // Sort numerically if possible (e.g. 详情1.jpg, 详情2.jpg)
        const numA = parseInt(a.replace(/[^0-9]/g, '')) || 0;
        const numB = parseInt(b.replace(/[^0-9]/g, '')) || 0;
        return numA - numB;
      });

    if (files.length === 0) {
      console.log(`⚠️ No valid files in folder: ${m.folder}`);
      continue;
    }

    console.log(`\n📁 Processing [${m.folder}] (Package ID: ${m.packageId}) with ${files.length} files:`);
    
    // Inactivate existing images for this package
    await conn.query(
      'UPDATE package_image SET is_active = 0 WHERE package_id = ? AND is_active = 1',
      [m.packageId]
    );
    console.log(`  📝 Inactivated existing images for Package ID: ${m.packageId}`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(dirPath, file);
      
      // Upload to OSS
      const objectName = genObjectName(file);
      const result = await client.put(objectName, filePath, {
        headers: {
          'Cache-Control': 'public, max-age=31536000, immutable'
        }
      });
      // Replace with custom domain
      const url = result.url.replace('http://', 'https://').replace('creativepro.oss-cn-shanghai.aliyuncs.com', 'img.domiyoung.com');
      totalUploaded++;
      
      console.log(`  ⬆️  [${i + 1}/${files.length}] ${file} -> ${url}`);

      // Insert new image record
      await conn.query(
        'INSERT INTO package_image (package_id, image_url, sort_order, is_active) VALUES (?, ?, ?, 1)',
        [m.packageId, url, i]
      );
    }
  }

  console.log(`\n\n🎉 SUCCESS: All ${totalUploaded} files uploaded and DB updated!`);
}

const sshConn = new Client();
sshConn.on('ready', () => {
  const server = net.createServer(socket => {
    sshConn.forwardOut(
      socket.remoteAddress,
      socket.remotePort,
      '127.0.0.1',
      3306,
      (err, stream) => {
        if (err) {
          socket.end();
          return;
        }
        socket.pipe(stream).pipe(socket);
      }
    );
  });

  server.listen(localPort, '127.0.0.1', async () => {
    console.log(`✅ SSH Tunnel established on local port ${localPort}`);
    let dbPool;
    try {
      dbPool = mysql.createPool({
        host: '127.0.0.1',
        port: localPort,
        user: 'root',
        password: '@Domi1688',
        database: 'wedding',
        waitForConnections: true,
        connectionLimit: 5,
      });
      const dbConn = await dbPool.getConnection();
      
      await dbConn.beginTransaction();
      try {
        await runUpload(dbConn);
        await dbConn.commit();
      } catch (uploadErr) {
        await dbConn.rollback();
        throw uploadErr;
      } finally {
        dbConn.release();
      }
      
    } catch (e) {
      console.error('❌ Error during execution:', e);
    } finally {
      if (dbPool) {
        await dbPool.end();
      }
      server.close();
      sshConn.end();
      process.exit(0);
    }
  });
}).connect(sshConfig);
