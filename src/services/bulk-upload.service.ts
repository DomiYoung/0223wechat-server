import AdmZip from 'adm-zip';
import OSS from 'ali-oss';
import pool from '../db.js';
import path from 'path';
import { appLogger } from '../logger.js';

const log = appLogger.child({ module: 'bulk-upload-service' });

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
    log.error({ err, objectName }, 'bulk upload oss put failed');
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
  log.info('bulk upload started');
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
    // 支持分类文件夹: 生日宝宝宴 / 商务宴会 下的子目录作为套餐项
    else if (!typeFolder || typeFolder) {
      // For category-based folders (non-venue), store items by sub-folder
      const itemName = typeFolder || 'default';
      const groupKey = `CATEGORY_ITEM_${itemName}`;
      if (!imageStructure[venueOrCategory][groupKey]) imageStructure[venueOrCategory][groupKey] = [];
      imageStructure[venueOrCategory][groupKey].push(entry);
    }
  }

  // ============================================================
  // 分类名 → package_category slug 映射
  // ============================================================
  const CATEGORY_SLUG_MAP: Record<string, string> = {
    '生日宝宝宴': 'birthday',
    '生日宴': 'birthday',
    '儿童宴': 'kids',
    '商务年会': 'business',
    '商务宴会': 'business',
    '婚宴菜单': 'wedding_menu',
    '婚庆套餐': 'wedding_pkg',
    '宴会套餐': 'wedding_pkg',
  };

  // Process gathered structure
  for (const venueName of Object.keys(imageStructure)) {
    log.info({ venueName }, 'bulk upload processing mapping');
    
    // Check if it's a structural venue (门店)
    const [venueResult] = await pool.query('SELECT id FROM venue WHERE name LIKE ? LIMIT 1', [`%${venueName}%`]) as any;
    const venueId = venueResult.length > 0 ? venueResult[0].id : null;

    // Check if it's a category-based folder (分类)
    const categorySlug = CATEGORY_SLUG_MAP[venueName];
    let packageCategoryId: number | null = null;
    if (categorySlug) {
      const [catResult] = await pool.query('SELECT id FROM package_category WHERE slug = ? LIMIT 1', [categorySlug]) as any;
      packageCategoryId = catResult.length > 0 ? catResult[0].id : null;
    }

    // Also handle combined folder names like "生日宝宝宴:商务年会"
    if (!venueId && !packageCategoryId && venueName.includes(':')) {
      const subNames = venueName.split(':');
      for (const subName of subNames) {
        const subSlug = CATEGORY_SLUG_MAP[subName.trim()];
        if (subSlug) {
          log.info({ venueName, subName: subName.trim() }, 'bulk upload detected combined category folder');
          // Mark it for later processing (we process it inline below)
        }
      }
    }

    if (!venueId && !packageCategoryId && (venueName.includes('旗舰店') || venueName.includes('漕河泾'))) {
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
          log.info({ venueName }, 'bulk upload updated venue lobby');
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
             log.info({ venueName, hallName }, 'bulk upload updated wedding case hall');
          } else {
             report.errors.push(`未匹配到宴会厅数据库记录: ${venueName} - ${hallName}`);
          }
       }
       // ============================================================
       // 分类套餐匹配 (生日宝宝宴 / 商务宴会)
       // ============================================================
       else if (groupKey.startsWith('CATEGORY_ITEM_') && packageCategoryId) {
          const itemName = groupKey.replace('CATEGORY_ITEM_', '');
          
          // Try to find an existing package with this name
          const [pkgResult] = await pool.query(
             'SELECT id FROM package WHERE category_id = ? AND title LIKE ? LIMIT 1',
             [packageCategoryId, `%${itemName}%`]
          ) as any;

          if (pkgResult.length > 0) {
             const pkgId = pkgResult[0].id;
             await pool.query('UPDATE package SET cover_url = ? WHERE id = ?', [coverUrl, pkgId]);
             await pool.query('DELETE FROM package_image WHERE package_id = ?', [pkgId]);
             for (let i = 0; i < uploadedUrls.length; i++) {
                await pool.query('INSERT INTO package_image (package_id, image_url, sort_order) VALUES (?, ?, ?)', [pkgId, uploadedUrls[i], i]);
             }
             report.packagesUpdated++;
             log.info({ venueName, itemName }, 'bulk upload updated package');
          } else {
             // Auto-create a new package entry under this category
             const [insertResult] = await pool.query(
               'INSERT INTO package (category_id, title, cover_url, is_active, sort_order) VALUES (?, ?, ?, 1, 0)',
               [packageCategoryId, itemName, coverUrl]
             ) as any;
             const newPkgId = insertResult.insertId;
             for (let i = 0; i < uploadedUrls.length; i++) {
                await pool.query('INSERT INTO package_image (package_id, image_url, sort_order) VALUES (?, ?, ?)', [newPkgId, uploadedUrls[i], i]);
             }
             report.packagesUpdated++;
             log.info({ venueName, itemName, packageId: newPkgId }, 'bulk upload created and updated package');
          }
       }
    }
  }

  log.info({ report }, 'bulk upload completed');
  return report;
}
