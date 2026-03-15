/**
 * Migration script: Download all non-OSS images from Weimob CDN,
 * re-upload them to Aliyun OSS, and replace all URLs in api_dump JSON files.
 * 
 * Run: node migrate_images_to_oss.js
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

async function main() {
    const dbModule = await import('./dist/db.js');
    const pool = dbModule.default || dbModule.pool || dbModule;

    // Dynamically import ali-oss
    const OSSModule = await import('ali-oss');
    const OSS = OSSModule.default;

    const ossClient = new OSS({
        region: process.env.ALIYUN_OSS_REGION || 'oss-cn-shanghai',
        accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID || '',
        accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET || '',
        bucket: process.env.ALIYUN_OSS_BUCKET || 'creativepro',
    });

    const DATA_DIR = path.join(process.cwd(), 'api_dump');
    const NON_OSS_DOMAINS = ['image-c.weimobwmc.com', 'stc.vc.weimob.cn', 'cdn2.weimob.com'];
    const OSS_PREFIX = 'wechat-miniprogram/migrated-weimob';

    // Step 1: Collect all unique non-OSS image URLs from JSON files
    console.log('📋 Step 1: Scanning JSON files for non-OSS image URLs...');
    const jsonFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const allNonOssUrls = new Set();

    for (const file of jsonFiles) {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
        const urlRegex = /https?:\/\/[^"'\s]+?\.(jpg|jpeg|png|gif|webp|svg)/gi;
        let match;
        while ((match = urlRegex.exec(content)) !== null) {
            const url = match[0];
            for (const domain of NON_OSS_DOMAINS) {
                if (url.includes(domain)) {
                    allNonOssUrls.add(url);
                    break;
                }
            }
        }
    }

    console.log(`   Found ${allNonOssUrls.size} unique non-OSS image URLs to migrate.`);

    // Step 2: Download each image and re-upload to OSS
    console.log('🚀 Step 2: Downloading and re-uploading to OSS...');
    const urlMapping = {};  // old URL → new OSS URL

    let count = 0;
    for (const oldUrl of allNonOssUrls) {
        count++;
        try {
            // Download
            const buffer = await downloadUrl(oldUrl);
            if (!buffer || buffer.length === 0) {
                console.warn(`   ⚠️ [${count}/${allNonOssUrls.size}] Empty download: ${oldUrl}`);
                continue;
            }

            // Determine extension
            const ext = path.extname(new URL(oldUrl).pathname) || '.jpg';
            const objectName = `${OSS_PREFIX}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;

            // Upload to OSS
            const result = await ossClient.put(objectName, buffer, {
                headers: {
                    'Content-Type': getMimeType(ext),
                    'Content-Disposition': 'inline',
                },
            });

            const newUrl = (result?.url || '').replace('http://', 'https://');
            if (newUrl) {
                urlMapping[oldUrl] = newUrl;
                console.log(`   ✅ [${count}/${allNonOssUrls.size}] ${oldUrl.slice(0, 60)}... → OSS`);
            }
        } catch (err) {
            console.error(`   ❌ [${count}/${allNonOssUrls.size}] Failed: ${oldUrl}`, err.message);
        }
    }

    console.log(`\n📊 Successfully migrated ${Object.keys(urlMapping).length} / ${allNonOssUrls.size} images.`);

    // Step 3: Replace all URLs in JSON files
    console.log('\n🔄 Step 3: Replacing URLs in api_dump JSON files...');
    let totalReplacements = 0;

    for (const file of jsonFiles) {
        const filePath = path.join(DATA_DIR, file);
        let content = fs.readFileSync(filePath, 'utf8');
        let fileReplacements = 0;

        for (const [oldUrl, newUrl] of Object.entries(urlMapping)) {
            const regex = new RegExp(escapeRegex(oldUrl), 'g');
            const matches = content.match(regex);
            if (matches) {
                fileReplacements += matches.length;
                content = content.replace(regex, newUrl);
            }
        }

        if (fileReplacements > 0) {
            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`   📝 ${file}: ${fileReplacements} URLs replaced`);
            totalReplacements += fileReplacements;
        }
    }

    console.log(`\n✅ Total URL replacements in JSON files: ${totalReplacements}`);

    // Step 4: Also update any non-OSS URLs in the database tables
    console.log('\n🔄 Step 4: Replacing URLs in database tables...');
    const tables = [
        { table: 'venue', columns: ['cover_url'] },
        { table: 'venue_image', columns: ['image_url'] },
        { table: 'wedding_case', columns: ['cover_url'] },
        { table: 'case_image', columns: ['image_url'] },
        { table: 'package', columns: ['cover_url'] },
        { table: 'package_image', columns: ['image_url'] },
        { table: 'brand', columns: ['logo_url'] },
    ];

    let dbReplacements = 0;
    for (const { table, columns } of tables) {
        for (const col of columns) {
            for (const [oldUrl, newUrl] of Object.entries(urlMapping)) {
                const [result] = await pool.execute(
                    `UPDATE ${table} SET ${col} = REPLACE(${col}, ?, ?) WHERE ${col} LIKE ?`,
                    [oldUrl, newUrl, `%${oldUrl}%`]
                );
                if (result.affectedRows > 0) {
                    dbReplacements += result.affectedRows;
                    console.log(`   📝 ${table}.${col}: ${result.affectedRows} rows updated`);
                }
            }
        }
    }

    console.log(`\n✅ Total DB replacements: ${dbReplacements}`);
    console.log('\n🎉 Migration complete!');
    process.exit(0);
}

function downloadUrl(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, { timeout: 15000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadUrl(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function getMimeType(ext) {
    const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
    return map[ext.toLowerCase()] || 'application/octet-stream';
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
