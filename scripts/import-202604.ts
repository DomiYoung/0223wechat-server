import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import OSS from 'ali-oss';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config(); // Ensure we load the current .env for DB and OSS

const DB_PORT = process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306;
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
});

const ossClient = new OSS({
    region: process.env.ALIYUN_OSS_REGION || 'oss-cn-shanghai',
    accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET || '',
    bucket: process.env.ALIYUN_OSS_BUCKET || 'creativepro',
});

const BATCH_VERSION = '2026-04';
const OLD_BATCH_VERSION = '2026-03';
const UPLOAD_BASE_PATH = `wechat-miniprogram/assets/${BATCH_VERSION}`;

const BASE_DIR = path.resolve(__dirname, '../../tmp_materials');

function getMimeType(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.mp4') return 'video/mp4';
    if (ext === '.m4v') return 'video/x-m4v';
    return 'application/octet-stream';
}

async function uploadFileToOSS(filePath: string): Promise<string> {
    const fileContent = fs.readFileSync(filePath);
    const mime = getMimeType(filePath);
    const fileName = path.basename(filePath);
    const objectName = `${UPLOAD_BASE_PATH}/${Date.now()}-${Math.random().toString(36).substring(2, 6)}-${fileName}`;
    
    console.log(`Uploading ${fileName}...`);
    const result = await ossClient.put(objectName, fileContent, {
        headers: {
            'Content-Type': mime,
            'Content-Disposition': 'inline',
        },
    });
    return result?.url?.replace('http://', 'https://');
}

// 收集特定目录中的图片和视频文件
function collectMediaFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) return [];
    let files: string[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.includes('__MACOSX')) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(collectMediaFiles(fullPath));
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.m4v'].includes(ext)) {
                files.push(fullPath);
            }
        }
    }
    return files;
}

// 将文件按是否有 "封面" 字样进行排序
function sortFiles(files: string[]) {
    return files.sort((a, b) => {
        const aIsCover = path.basename(a).includes('封面');
        const bIsCover = path.basename(b).includes('封面');
        if (aIsCover && !bIsCover) return -1;
        if (!aIsCover && bIsCover) return 1;
        return path.basename(a).localeCompare(path.basename(b));
    });
}

function normalizeHallName(dirName: string) {
    return dirName.replace(/（.*）|\(.*\)/g, '').trim();
}

async function run() {
    console.log('--- 开始导入素材 ---');
    console.log('数据库主机:', process.env.DB_HOST, '端口:', DB_PORT);

    // 1. 归档现有数据
    console.log(`\n[阶段1] 归档旧数据到批次 ${OLD_BATCH_VERSION} ...`);
    const [caseArchive] = await pool.execute(
        `UPDATE wedding_case SET is_active = 0, batch_version = ? WHERE is_active = 1 AND (batch_version IS NULL OR batch_version = '')`,
        [OLD_BATCH_VERSION]
    ) as any;
    console.log(`- 归档了 ${caseArchive.affectedRows} 个案例.`);

    const [pkgArchive] = await pool.execute(
        `UPDATE package SET is_active = 0, batch_version = ? WHERE is_active = 1 AND (batch_version IS NULL OR batch_version = '')`,
        [OLD_BATCH_VERSION]
    ) as any;
    console.log(`- 归档了 ${pkgArchive.affectedRows} 个套餐.`);

    // 2. 加载基础分类信息
    const [venueRows] = await pool.execute(`SELECT id, name FROM venue`) as any;
    const [categoryRows] = await pool.execute(`SELECT id, name, slug FROM package_category`) as any;

    const findVenueId = (name: string) => {
        const v = venueRows.find((r: any) => r.name.includes(name) || name.includes(r.name));
        return v ? v.id : null;
    };

    const findCategoryIdByKeywords = (keywords: string[]) => {
        let matched = categoryRows.find((r: any) => keywords.some(k => r.name.includes(k) || r.slug?.includes(k)));
        return matched ? matched.id : null;
    };


    // 3. 处理素材
    const topsDirs = ['旗舰店', '漕河泾臻选店', '其余'];

    for (const topDir of topsDirs) {
        const fullDirPath = path.join(BASE_DIR, topDir);
        if (!fs.existsSync(fullDirPath)) {
            console.log(`Directory not found: ${fullDirPath}`);
            continue;
        }

        console.log(`\n============== 开始处理顶层文件夹: ${topDir} ==============`);

        const subDirs = fs.readdirSync(fullDirPath, { withFileTypes: true });

        for (const sub of subDirs) {
            if (!sub.isDirectory() || sub.name.startsWith('.') || sub.name.includes('__MACOSX')) continue;
            
            const categoryName = sub.name; // 比如 "教堂婚礼", "最上方轮播图", "裴宝刻", "门店", "生日宴..."
            const itemPath = path.join(fullDirPath, categoryName);
            const rawFiles = collectMediaFiles(itemPath);

            if (rawFiles.length === 0) continue;
            const files = sortFiles(rawFiles);
            console.log(`\n-> 找到分类: ${categoryName} (文件数: ${files.length})`);

            let uploadedUrls: string[] = [];
            for (const file of files) {
                const url = await uploadFileToOSS(file);
                if (url) uploadedUrls.push(url);
            }
            if (uploadedUrls.length === 0) continue;

            const coverUrl = uploadedUrls[0];
            const venueName = topDir.split('/')[0];
            const venueId = venueName === '其余' ? null : findVenueId(venueName);

            // ================== 处理 "门店" 的情况 (其余/门店) ==================
            if (categoryName === '门店' && venueName === '其余') {
                for(let i = 0; i < files.length; i++) {
                    const shopName = path.basename(files[i], path.extname(files[i]));
                    const sVenueId = findVenueId(shopName);
                    if (sVenueId) {
                        await pool.execute('UPDATE venue SET cover_url = ? WHERE id = ?', [uploadedUrls[i], sVenueId]);
                        console.log(`  * 更新门店封面: ${shopName} -> ${uploadedUrls[i]}`);
                    }
                }
            } 
            // ================== 处理 轮播图 的情况 ==================
            else if (categoryName === '最上方轮播图' && venueId) {
                await pool.query('DELETE FROM venue_image WHERE venue_id = ?', [venueId]);
                for (let i = 0; i < uploadedUrls.length; i++) {
                    await pool.query('INSERT INTO venue_image (venue_id, image_url, sort_order) VALUES (?, ?, ?)', [venueId, uploadedUrls[i], i]);
                }
                console.log(`  * 更新门店轮播图: ${venueName} 数量 ${uploadedUrls.length}`);
            }
            // ================== 处理 "套餐" 的情况 (生日宴 / 商务宴会 / 宴会套餐) ==================
            else if (venueName === '其余') {
                let catId = null;
                if (categoryName.includes('生日') || categoryName.includes('宝宝')) {
                    catId = findCategoryIdByKeywords(['生日', '宝宝', '儿童', 'birthday', 'kids']);
                } else if (categoryName.includes('商务')) {
                    catId = findCategoryIdByKeywords(['商务', '年会', 'business']);
                } else if (categoryName.includes('套餐') || categoryName.includes('婚宴')) {
                    catId = findCategoryIdByKeywords(['婚宴', '婚庆', '套餐', 'wedding_pkg', 'wedding_menu']);
                }

                if (catId) {
                    // 分套餐小项 (以目录为单位)
                    // But wait, the categoryName could contain subdirectories!
                    // Let's actually look at the files' immediate parent directory inside this category.
                    // If files are directly in 'categoryName', then that's the title.
                    // E.g., "其余/生日宴-改宝宝生日宴/3980元 宝宝宴菜单/xxx.jpg" -> title "3980元 宝宝宴菜单"

                    // Use a Map to separate urls by their direct parent folder.
                    const subMap = new Map<string, string[]>();
                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        const url = uploadedUrls[i];
                        let itemTitle = path.basename(path.dirname(file));
                        // If itemTitle is the same as categoryName, meaning files are dumped directly, we just use the file name as itemTitle
                        if (itemTitle === categoryName) {
                            itemTitle = path.basename(file, path.extname(file));
                        }
                        if (!subMap.has(itemTitle)) subMap.set(itemTitle, []);
                        subMap.get(itemTitle)!.push(url);
                    }

                    for (const [itemTitle, urls] of subMap.entries()) {
                        const [res] = await pool.execute(
                            `INSERT INTO package (category_id, title, cover_url, is_active, sort_order, batch_version) VALUES (?, ?, ?, 1, 0, ?)`,
                            [catId, itemTitle, urls[0], BATCH_VERSION]
                        ) as any;
                        const pkgId = res.insertId;
                        for (let i = 0; i < urls.length; i++) {
                            await pool.execute('INSERT INTO package_image (package_id, image_url, sort_order) VALUES (?, ?, ?)', [pkgId, urls[i], i]);
                        }
                        console.log(`  * 添加包办套餐: ${itemTitle} 类别ID: ${catId}`);
                    }

                } else {
                    console.log(`  ! 未找到对应分类，跳过 ${categoryName}`);
                }
            }
            // ================== 处理 "婚礼主题 / 宴会厅" 的情况 ==================
            else if (venueId) {
                // Here category name is something like '教堂婚礼', '派乐殿', '枫汀南（上传1）'
                // We should normalize it to get the hall_name
                let hallName = normalizeHallName(categoryName);
                
                // Deal with multiple uploads of the same hall (e.g. 枫汀南 uploaded 3 times)
                // We will check if an active case of THIS BATCH already exists.
                const [existingCase] = await pool.execute(
                    `SELECT id FROM wedding_case WHERE venue_id = ? AND hall_name = ? AND batch_version = ?`,
                    [venueId, hallName, BATCH_VERSION]
                ) as any;

                let caseId = existingCase.length > 0 ? existingCase[0].id : null;
                
                if (!caseId) {
                    // Create new case
                    const [res] = await pool.execute(
                        `INSERT INTO wedding_case (title, hall_name, venue_id, cover_url, style, is_featured, is_active, sort_order, batch_version)
                         VALUES (?, ?, ?, ?, ?, 1, 1, 0, ?)`,
                        [hallName, hallName, venueId, coverUrl, hallName, BATCH_VERSION]
                    ) as any;
                    caseId = res.insertId;
                    console.log(`  * 创建新案例: ${hallName} (Venue ID: ${venueId})`);
                } else {
                    console.log(`  * 追加到现有案例: ${hallName} (Case ID: ${caseId})`);
                }

                // Add images to case
                const [curImagesCountRes] = await pool.execute('SELECT COUNT(*) as cnt FROM case_image WHERE case_id = ?', [caseId]) as any;
                let startPos = curImagesCountRes[0].cnt;

                for (let i = 0; i < uploadedUrls.length; i++) {
                    await pool.execute('INSERT INTO case_image (case_id, image_url, sort_order, batch_version) VALUES (?, ?, ?, ?)', [caseId, uploadedUrls[i], startPos + i, BATCH_VERSION]);
                }
            }
        }
    }

    console.log('\n--- 导入完成 ---');
    process.exit(0);
}

run().catch((err) => {
    console.error('Import failed:', err);
    process.exit(1);
});
