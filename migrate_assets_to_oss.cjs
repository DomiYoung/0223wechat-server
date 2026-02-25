const https = require('https');
const OSS = require('ali-oss');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

console.log('OSS Bucket:', process.env.ALIYUN_OSS_BUCKET);

function getClient() {
    return new OSS({
        region: process.env.ALIYUN_OSS_REGION,
        accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
        accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
        bucket: process.env.ALIYUN_OSS_BUCKET,
        secure: true
    });
}

async function getShopJson() {
    return new Promise((resolve, reject) => {
        https.get('https://api.huajialishe.com/constant/json/wx-miniprogram/shop.json', (res) => {
            res.setEncoding('utf8');
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
            res.on('error', reject);
        });
    });
}

async function downloadImage(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
    });
}

async function migrate() {
    console.log('Fetching shop.json...');
    const data = await getShopJson();

    // Map of filename -> sourceUrl
    const migrationMap = new Map();
    const PHOTO_BASE = 'https://photos.huajialishe.cn/';

    for (const cityCode of ['sh', 'bj', 'nj']) {
        const items = data[cityCode] || [];
        for (const item of items) {
            // Cover Image
            if (item.img && !item.img.startsWith('http')) {
                migrationMap.set(item.img, PHOTO_BASE + item.img);
            }

            // SubPage Images
            if (item.subPage) {
                for (const sub of item.subPage) {
                    if (sub.url) {
                        const filename = sub.url.split('/').pop();
                        if (sub.url.startsWith('http')) {
                            migrationMap.set(filename, sub.url);
                        } else {
                            migrationMap.set(filename, PHOTO_BASE + sub.url);
                        }
                    }
                }
            }
        }
    }

    console.log(`Found ${migrationMap.size} unique images to migrate.`);

    let success = 0;
    let skipped = 0;
    let failed = 0;

    const client = getClient();

    for (const [filename, sourceUrl] of migrationMap) {
        const ossPath = `migrated/${filename}`;

        try {
            // Check if exists to save time/bandwidth
            try {
                await client.head(ossPath);
                // console.log(`Skipping existing: ${filename}`); 
                skipped++;
                continue;
            } catch (e) { }

            console.log(`Migrating: ${filename} from ${sourceUrl} ...`);
            const buffer = await downloadImage(sourceUrl);
            await client.put(ossPath, buffer);
            success++;
        } catch (error) {
            console.error(`Failed to migrate ${filename} (${sourceUrl}):`, error.message);
            failed++;
        }
    }

    console.log(`Migration Complete! Success: ${success}, Skipped: ${skipped}, Failed: ${failed}`);
}

migrate().catch(console.error);
