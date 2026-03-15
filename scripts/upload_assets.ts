import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import OSS from 'ali-oss';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

// OSS Configuration
const client = new OSS({
  region: process.env.ALIYUN_OSS_REGION || 'oss-cn-shanghai',
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET || '',
  bucket: process.env.ALIYUN_OSS_BUCKET || 'creativepro',
});

// DB Configuration
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'wedding',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const uploadPathBase = 'wechat-miniprogram/assets/0305';

async function uploadToOSS(filePath, objectName) {
  try {
    const result = await client.put(objectName, filePath);
    // return url with custom domain or use OSS url directly. If domain isn't bind, use OSS URL.
    return result.url.replace(/^http:/, 'https:');
  } catch (err) {
    console.error(`Error uploading ${filePath}:`, err);
    return null;
  }
}

async function processDirectory(dirPath, venueName, isFlagship) {
   const themeDir = join(dirPath, '婚礼主题');
   if (statSync(themeDir).isDirectory()) {
       const halls = readdirSync(themeDir).filter(f => !f.startsWith('.'));
       for (const hall of halls) {
           const hallPath = join(themeDir, hall);
           if (!statSync(hallPath).isDirectory()) continue;

           console.log(`Processing venue: ${venueName}, hall: ${hall}`);
           const images = readdirSync(hallPath).filter(f => !f.startsWith('.') && (f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.png')));
           let coverUrl = null;
           const imageUrls = [];

           for (const img of images) {
               const imgPath = join(hallPath, img);
               const objectName = `${uploadPathBase}/venues/${venueName}/${hall}/${img}`;
               console.log(`Uploading ${img}...`);
               const url = await uploadToOSS(imgPath, objectName);
               if (url) {
                   imageUrls.push(url);
                   if (!coverUrl) coverUrl = url; // first image as cover
               }
           }

           if (imageUrls.length > 0) {
               // Update Database
               const [venueResult] = await pool.query('SELECT id FROM venue WHERE name LIKE ? LIMIT 1', [`%${venueName}%`]);
               let venueId = null;
               if(venueResult.length > 0) {
                 venueId = venueResult[0].id;
               } else {
                 console.log(`Venue not found: ${venueName}`);
                 continue;
               }

               const [caseResult] = await pool.query('SELECT id FROM wedding_case WHERE venue_id = ? AND title LIKE ? LIMIT 1', [venueId, `%${hall}%`]);
               let caseId = null;

               if(caseResult.length > 0) {
                  caseId = caseResult[0].id;
                  // Update cover
                  await pool.query('UPDATE wedding_case SET cover_url = ? WHERE id = ?', [coverUrl, caseId]);
                  // Insert case images 
                  // First clear old
                  await pool.query('DELETE FROM case_image WHERE case_id = ?', [caseId]);
                  for(let i=0; i<imageUrls.length; i++) {
                     await pool.query('INSERT INTO case_image (case_id, image_url, sort_order) VALUES (?, ?, ?)', [caseId, imageUrls[i], i]);
                  }
                  console.log(`DB updated for ${venueName} - ${hall}`);
               } else {
                 console.log(`Hall not found in DB: ${venueName} - ${hall}`);
               }
           }
       }
   }
   
   const outerLobbyDir = join(dirPath, '外立面大堂');
   if (isFlagship === false && statSync(outerLobbyDir).isDirectory()) { // Only Caohejing has this in the zip
        console.log(`Processing lobby for ${venueName}`);
        const images = readdirSync(outerLobbyDir).filter(f => !f.startsWith('.') && (f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.png')));
        const imageUrls = [];
        let coverUrl = null;
        for (const img of images) {
            const imgPath = join(outerLobbyDir, img);
            const objectName = `${uploadPathBase}/venues/${venueName}/lobby/${img}`;
            const url = await uploadToOSS(imgPath, objectName);
            if(url) {
                imageUrls.push(url);
                if (!coverUrl) coverUrl = url;
            }
        }
        if (imageUrls.length > 0) {
           const [venueResult] = await pool.query('SELECT id FROM venue WHERE name LIKE ? LIMIT 1', [`%${venueName}%`]);
           if(venueResult.length > 0) {
               const venueId = venueResult[0].id;
               await pool.query('UPDATE venue SET cover_url = ? WHERE id = ?', [coverUrl, venueId]);
               // Insert venue images
               await pool.query('DELETE FROM venue_image WHERE venue_id = ?', [venueId]);
               for(let i=0; i<imageUrls.length; i++) {
                   await pool.query('INSERT INTO venue_image (venue_id, image_url, sort_order) VALUES (?, ?, ?)', [venueId, imageUrls[i], i]);
               }
               console.log(`DB updated for lobby ${venueName}`);
           }
        }
   }
}

async function processPackages() {
    const pkgDir = '/tmp/mp_assets/小程序素材/宴会套餐/晚宴图集';
    const lunchDir = '/tmp/mp_assets/小程序素材/宴会套餐/午宴图集';
    // The zip structure doesn't match the package names exactly. We need custom logic.
    // E.g., match price with package item and update their image_urls.
    // For packages, I will create a simpler match logic based on the names found earlier.
    console.log("Packages processing will be implemented based on DB matching...")
}

async function processBirthdayBusiness() {
    const dir = '/tmp/mp_assets/小程序素材/生日宝宝宴:商务年会';
    // Similar specific matching logic
}


async function main() {
    console.log('Starting OSS upload and DB update script...');
    
    // 1. Process Flagship
    const flagshipPath = '/tmp/mp_assets/小程序素材/旗舰店';
    await processDirectory(flagshipPath, '旗舰店', true);
    
    // 2. Process Caohejing
    const caohejingPath = '/tmp/mp_assets/小程序素材/漕河泾臻选店';
    await processDirectory(caohejingPath, '漕河泾臻选店', false);

    // Further logic for packages/birthday
    await processPackages();
    await processBirthdayBusiness();
    
    console.log('Script completed.');
    pool.end();
}

main().catch(console.error);
