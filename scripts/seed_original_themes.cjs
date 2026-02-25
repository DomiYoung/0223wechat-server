/**
 * 增量同步原始主题数据
 *
 * 策略：
 *   1. 从 shop.json 获取最新数据
 *   2. 以 title + venue_id 为唯一标识，判断主题是否已存在
 *   3. 已存在 → 更新 cover_url / shop_label（幂等）
 *   4. 不存在 → INSERT 新主题
 *   5. 图片同理：先查已有图片 URL，只插入新增的
 *
 * 运行：node scripts/seed_original_themes.cjs
 */
const mysql = require('mysql2/promise');
const https = require('https');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

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
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'wedding_cms',
    });

    console.log('📦 Fetching shop.json...');
    const data = await getShopJson();

    // 获取门店映射
    const [venues] = await db.execute('SELECT id, city FROM venue');
    const cityMap = {};
    venues.forEach(v => {
        if (v.city.includes('上海')) cityMap.sh = v.id;
        if (v.city.includes('北京')) cityMap.bj = v.id;
        if (v.city.includes('南京')) cityMap.nj = v.id;
    });

    // 获取已有主题（以 title + venue_id 为唯一键）
    const [existingThemes] = await db.execute(
        'SELECT id, title, venue_id FROM wedding_case'
    );
    const themeIndex = new Map();
    existingThemes.forEach(t => themeIndex.set(`${t.title}__${t.venue_id}`, t.id));

    // 获取已有图片 URL（用于去重）
    const [existingImages] = await db.execute(
        'SELECT case_id, image_url FROM case_image'
    );
    const imageIndex = new Set();
    existingImages.forEach(img => imageIndex.add(`${img.case_id}__${img.image_url}`));

    const OSS_MIGRATED_BASE = 'https://creativepro.oss-cn-shanghai.aliyuncs.com/migrated/';

    let inserted = 0, updated = 0, skippedImages = 0, newImages = 0;

    for (const cityCode of ['sh', 'bj', 'nj']) {
        const items = data[cityCode] || [];
        const venueId = cityMap[cityCode];
        if (!venueId) {
            console.log(`⚠️ 城市 ${cityCode} 未找到对应门店，跳过`);
            continue;
        }

        const shopLabel = cityCode === 'sh' ? '上海' : (cityCode === 'bj' ? '北京' : '南京');
        console.log(`\n🏙️  处理 ${shopLabel} (${items.length} 个主题)...`);

        for (const item of items) {
            // 清洗店名
            let storeIndex = item.index || '';
            if (storeIndex.includes('海') && storeIndex.includes('婚礼店')) storeIndex = '海岛婚礼店';
            else if (storeIndex.includes('空') && storeIndex.includes('花园店')) storeIndex = '空中花园店';
            else if (storeIndex.includes('国展')) storeIndex = '国展店';
            else if (storeIndex.includes('外滩')) storeIndex = '外滩店';

            const filename = item.img ? item.img.split('/').pop() : '';
            const coverUrl = filename ? OSS_MIGRATED_BASE + filename : '';

            const key = `${item.title}__${venueId}`;
            let caseId;

            if (themeIndex.has(key)) {
                // ✅ 已存在 → 更新（幂等）
                caseId = themeIndex.get(key);
                await db.execute(
                    `UPDATE wedding_case SET cover_url = ?, shop_label = ?, style = ? WHERE id = ?`,
                    [coverUrl, shopLabel, storeIndex, caseId]
                );
                updated++;
            } else {
                // 🆕 不存在 → 插入
                const [result] = await db.execute(
                    `INSERT INTO wedding_case (title, style, cover_url, venue_id, is_active, sort_order, shop_label)
                     VALUES (?, ?, ?, ?, 1, 0, ?)`,
                    [item.title, storeIndex, coverUrl, venueId, shopLabel]
                );
                caseId = result.insertId;
                themeIndex.set(key, caseId); // 更新内存索引
                inserted++;
            }

            // 增量同步图片（只插入不存在的）
            if (item.subPage && item.subPage.length > 0) {
                for (let i = 0; i < item.subPage.length; i++) {
                    const subFilename = item.subPage[i].url ? item.subPage[i].url.split('/').pop() : '';
                    const imgUrl = subFilename ? OSS_MIGRATED_BASE + subFilename : '';

                    if (!imgUrl) continue;

                    const imgKey = `${caseId}__${imgUrl}`;
                    if (imageIndex.has(imgKey)) {
                        skippedImages++;
                        continue;
                    }

                    await db.execute(
                        'INSERT INTO case_image (case_id, image_url, sort_order) VALUES (?, ?, ?)',
                        [caseId, imgUrl, i]
                    );
                    imageIndex.add(imgKey); // 更新内存索引
                    newImages++;
                }
            }
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log(`✅ 同步完成！`);
    console.log(`   主题: ${inserted} 新增, ${updated} 更新, ${themeIndex.size} 总计`);
    console.log(`   图片: ${newImages} 新增, ${skippedImages} 跳过（已存在）`);
    console.log('='.repeat(50));

    await db.end();
}

seed().catch(console.error);
