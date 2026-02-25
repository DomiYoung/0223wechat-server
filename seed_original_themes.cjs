const mysql = require('mysql2/promise');
const https = require('https');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

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

async function seed() {
    const db = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: '@Domi1688',
        database: 'wedding'
    });

    console.log('Fetching shop.json...');
    const data = await getShopJson();

    console.log('Fetching Venue mappings...');
    const [venues] = await db.execute('SELECT id, city FROM venue');
    const cityMap = {};
    venues.forEach(v => {
        if (v.city.includes('上海')) cityMap.sh = v.id;
        if (v.city.includes('北京')) cityMap.bj = v.id;
        if (v.city.includes('南京')) cityMap.nj = v.id;
    });

    const OSS_MIGRATED_BASE = 'https://creativepro.oss-cn-shanghai.aliyuncs.com/migrated/';

    for (const cityCode of ['sh', 'bj', 'nj']) {
        const items = data[cityCode] || [];
        const venueId = cityMap[cityCode];
        console.log(`Processing ${cityCode} (${items.length} items)...`);

        for (const item of items) {
            // 清洗店名，确保展示正确
            let storeIndex = item.index || '';
            if (storeIndex.includes('海') && storeIndex.includes('婚礼店')) storeIndex = '海岛婚礼店';
            else if (storeIndex.includes('空') && storeIndex.includes('花园店')) storeIndex = '空中花园店';
            else if (storeIndex.includes('国展')) storeIndex = '国展店';
            else if (storeIndex.includes('外滩')) storeIndex = '外滩店';

            // 封面图：指向迁移后的 OSS 路径
            const filename = item.img.split('/').pop();
            const coverUrl = OSS_MIGRATED_BASE + filename;

            const shopLabel = cityCode === 'sh' ? '上海' : (cityCode === 'bj' ? '北京' : '南京');

            // 1. Insert into wedding_case
            const [result] = await db.execute(
                `INSERT INTO wedding_case (title, case_type, style, cover_url, venue_id, is_active, sort_order, shop_label) 
                 VALUES (?, "theme", ?, ?, ?, 1, 0, ?)`,
                [item.title, storeIndex, coverUrl, venueId, shopLabel]
            );
            const caseId = result.insertId;

            // 2. Insert subPage images into case_image
            if (item.subPage && item.subPage.length > 0) {
                for (let i = 0; i < item.subPage.length; i++) {
                    const subFilename = item.subPage[i].url.split('/').pop();
                    const imgUrl = OSS_MIGRATED_BASE + subFilename;

                    await db.execute(
                        'INSERT INTO case_image (case_id, image_url, sort_order) VALUES (?, ?, ?)',
                        [caseId, imgUrl, i]
                    );
                }
            }
        }
    }

    console.log('Seeding complete!');
    await db.end();
}

seed().catch(console.error);
