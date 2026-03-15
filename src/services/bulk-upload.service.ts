import AdmZip from 'adm-zip';
import OSS from 'ali-oss';
import pool from '../db.js';
import path from 'path';

// OSS Client
const ossClient = new OSS({
  region: process.env.ALIYUN_OSS_REGION || 'oss-cn-shanghai',
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET || '',
  bucket: process.env.ALIYUN_OSS_BUCKET || 'creativepro',
});

const uploadPathBase = 'wechat-miniprogram/assets/bulk';

async function uploadBufferToOSS(buffer: Buffer, objectName: string, mimeType: string) {
  try {
    const result = await ossClient.put(objectName, buffer, {
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Disposition': 'inline',
      },
    });
    return result?.url?.replace('http://', 'https://') || null;
  } catch (err) {
    console.error(`[BulkUpload] Error uploading ${objectName}:`, err);
    return null;
  }
}

function getMimeType(filename: string) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

export async function processBulkUpload(zipBuffer: Buffer) {
  console.log('[BulkUpload] Started processing ZIP file');
  const zip = new AdmZip(zipBuffer);
  const zipEntries = zip.getEntries();
  
  const report = {
    totalFiles: 0,
    venuesUpdated: 0,
    casesUpdated: 0,
    packagesUpdated: 0,
    errors: [] as string[]
  };

  // Group images by folder paths
  const imageStructure: Record<string, Record<string, AdmZip.IZipEntry[]>> = {};

  for (const entry of zipEntries) {
    if (entry.isDirectory || entry.entryName.includes('__MACOSX') || entry.name.startsWith('.')) {
      continue; // Skip hidden Mac files and directories
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      continue;
    }

    report.totalFiles++;

    // Example path: 小程序素材/旗舰店/婚礼主题/派乐殿/DSC01386.jpg
    // or: 小程序素材/漕河泾臻选店/外立面大堂/xxx.jpg
    const parts = entry.entryName.split('/');
    if (parts.length < 3) continue;

    // Filter out root wrap folder if exists
    let startIndex = 0;
    if (parts[0] === '小程序素材') startIndex = 1;

    const venueOrCategory = parts[startIndex]; // 旗舰店 / 漕河泾臻选店 / 宴会套餐 / 生日宝宝宴:商务年会
    const typeFolder = parts[startIndex + 1]; // 婚礼主题 / 外立面大堂 / 午宴图集
    let hallOrItem = parts[startIndex + 2]; // 派乐殿

    if (!venueOrCategory) continue;

    if (!imageStructure[venueOrCategory]) {
      imageStructure[venueOrCategory] = {};
    }

    // For lobby (大堂), group under lobby
    if (typeFolder === '外立面大堂') {
      const groupKey = 'LOBBY';
      if (!imageStructure[venueOrCategory][groupKey]) imageStructure[venueOrCategory][groupKey] = [];
      imageStructure[venueOrCategory][groupKey].push(entry);
    } 
    else if (typeFolder === '婚礼主题' && hallOrItem) {
      const groupKey = `HALL_${hallOrItem}`;
      if (!imageStructure[venueOrCategory][groupKey]) imageStructure[venueOrCategory][groupKey] = [];
      imageStructure[venueOrCategory][groupKey].push(entry);
    }
  }

  // Process gathered structure
  for (const venueName of Object.keys(imageStructure)) {
    console.log(`[BulkUpload] Processing mapping for: ${venueName}`);
    
    // Check if it's a structural venue
    const [venueResult] = await pool.query('SELECT id FROM venue WHERE name LIKE ? LIMIT 1', [`%${venueName}%`]) as any;
    const venueId = venueResult.length > 0 ? venueResult[0].id : null;

    if (!venueId && (venueName.includes('旗舰店') || venueName.includes('漕河泾'))) {
       report.errors.push(`未能在数据库找到匹配的门店: ${venueName}`);
       continue;
    }

    const groups = imageStructure[venueName];

    for (const groupKey of Object.keys(groups)) {
       const entries = groups[groupKey];
       if (entries.length === 0) continue;

       // Sort entries natively so that cover image might be predictable
       entries.sort((a, b) => a.name.localeCompare(b.name));

       const uploadedUrls: string[] = [];
       for (const entry of entries) {
          const buffer = entry.getData();
          const mime = getMimeType(entry.name);
          const objectName = `${uploadPathBase}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${entry.name}`;
          const url = await uploadBufferToOSS(buffer, objectName, mime);
          if (url) uploadedUrls.push(url);
       }

       if (uploadedUrls.length === 0) continue;
       const coverUrl = uploadedUrls[0];

       if (groupKey === 'LOBBY' && venueId) {
          // Update venue cover and banner images
          await pool.query('UPDATE venue SET cover_url = ? WHERE id = ?', [coverUrl, venueId]);
          await pool.query('DELETE FROM venue_image WHERE venue_id = ?', [venueId]);
          for (let i = 0; i < uploadedUrls.length; i++) {
             await pool.query('INSERT INTO venue_image (venue_id, image_url, sort_order) VALUES (?, ?, ?)', [venueId, uploadedUrls[i], i]);
          }
          report.venuesUpdated++;
          console.log(`[BulkUpload] Updated Venue Lobby: ${venueName}`);
       } 
       else if (groupKey.startsWith('HALL_') && venueId) {
          const hallName = groupKey.replace('HALL_', '');
          const [caseResult] = await pool.query(
             'SELECT id FROM wedding_case WHERE venue_id = ? AND (title LIKE ? OR hall_name LIKE ?) LIMIT 1', 
             [venueId, `%${hallName}%`, `%${hallName}%`]
          ) as any;

          if (caseResult.length > 0) {
             const caseId = caseResult[0].id;
             await pool.query('UPDATE wedding_case SET cover_url = ? WHERE id = ?', [coverUrl, caseId]);
             await pool.query('DELETE FROM case_image WHERE case_id = ?', [caseId]);
             for (let i = 0; i < uploadedUrls.length; i++) {
                await pool.query('INSERT INTO case_image (case_id, image_url, sort_order) VALUES (?, ?, ?)', [caseId, uploadedUrls[i], i]);
             }
             report.casesUpdated++;
             console.log(`[BulkUpload] Updated Wedding Case Hall: ${venueName} - ${hallName}`);
          } else {
             report.errors.push(`未匹配到宴会厅数据库记录: ${venueName} - ${hallName}`);
          }
       }
    }
  }

  // TODO: Add package logic similarly if we have predictable folder names for packages
  // We will leave packages logic flexible or run it via CMS manually for packages. 

  console.log('[BulkUpload] Processing Complete:', report);
  return report;
}
