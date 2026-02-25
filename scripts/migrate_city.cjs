/**
 * 城市数据迁移脚本
 *
 * 功能：
 *   1. 从 venue.city 字段提取唯一城市，写入 city 表
 *   2. 更新 venue.city_id 关联
 *   3. 更新 reservation.city → city_id
 *
 * 运行：node scripts/migrate_city.cjs
 */
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function migrate() {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'wedding_cms',
    });

    console.log('🏙️  城市数据迁移开始...\n');

    // 1. 检查 city 表是否为空
    const [existingCities] = await db.execute('SELECT COUNT(*) as count FROM city');
    if (existingCities[0].count > 0) {
        console.log('⚠️  city 表已有数据，跳过初始化');
    } else {
        // 2. 从 venue.city 提取唯一城市
        const [uniqueCities] = await db.execute(
            'SELECT DISTINCT city FROM venue WHERE city != "" ORDER BY city'
        );

        if (uniqueCities.length === 0) {
            console.log('⚠️  venue 表无城市数据，使用默认值');
            // 插入默认城市
            const defaultCities = [
                { name: '上海', region: '华东' },
                { name: '北京', region: '华北' },
                { name: '南京', region: '华东' }
            ];
            for (let i = 0; i < defaultCities.length; i++) {
                await db.execute(
                    'INSERT INTO city (name, region, sort_order) VALUES (?, ?, ?)',
                    [defaultCities[i].name, defaultCities[i].region, i]
                );
                console.log(`   ✅ 创建城市: ${defaultCities[i].name}`);
            }
        } else {
            // 从 venue 提取城市
            for (let i = 0; i < uniqueCities.length; i++) {
                const cityName = uniqueCities[i].city;
                const region = cityName.includes('上海') || cityName.includes('南京') ? '华东' : '华北';
                await db.execute(
                    'INSERT INTO city (name, region, sort_order) VALUES (?, ?, ?)',
                    [cityName, region, i]
                );
                console.log(`   ✅ 迁移城市: ${cityName}`);
            }
        }
    }

    // 3. 获取城市映射
    const [cities] = await db.execute('SELECT id, name FROM city');
    const cityMap = new Map();
    cities.forEach(c => cityMap.set(c.name, c.id));
    console.log(`\n📋 城市映射: ${JSON.stringify(Object.fromEntries(cityMap))}`);

    // 4. 更新 venue.city_id
    console.log('\n🏠 更新门店城市关联...');
    const [venues] = await db.execute('SELECT id, city FROM venue WHERE city_id IS NULL AND city != ""');
    let venueUpdated = 0;
    for (const venue of venues) {
        const cityId = cityMap.get(venue.city);
        if (cityId) {
            await db.execute('UPDATE venue SET city_id = ? WHERE id = ?', [cityId, venue.id]);
            venueUpdated++;
        }
    }
    console.log(`   ✅ 更新 ${venueUpdated} 个门店`);

    // 5. 检查 reservation 表是否有 city_id 列
    try {
        await db.execute('ALTER TABLE reservation ADD COLUMN city_id INT DEFAULT NULL COMMENT "关联城市" AFTER city');
        await db.execute('ALTER TABLE reservation ADD INDEX idx_city_id (city_id)');
        console.log('\n📝 为 reservation 表添加 city_id 列');
    } catch (_) { /* 列已存在 */ }

    // 6. 更新 reservation.city_id
    console.log('\n📝 更新预约城市关联...');
    const [reservations] = await db.execute('SELECT id, city FROM reservation WHERE city_id IS NULL AND city != ""');
    let resUpdated = 0;
    for (const res of reservations) {
        const cityId = cityMap.get(res.city);
        if (cityId) {
            await db.execute('UPDATE reservation SET city_id = ? WHERE id = ?', [cityId, res.id]);
            resUpdated++;
        }
    }
    console.log(`   ✅ 更新 ${resUpdated} 条预约`);

    // 7. 统计结果
    console.log('\n📊 迁移结果:');
    const [cityCount] = await db.execute('SELECT COUNT(*) as c FROM city');
    const [venueWithCity] = await db.execute('SELECT COUNT(*) as c FROM venue WHERE city_id IS NOT NULL');
    const [venueTotal] = await db.execute('SELECT COUNT(*) as c FROM venue');
    const [resWithCity] = await db.execute('SELECT COUNT(*) as c FROM reservation WHERE city_id IS NOT NULL');
    const [resTotal] = await db.execute('SELECT COUNT(*) as c FROM reservation');

    console.log(`   城市数量: ${cityCount[0].c}`);
    console.log(`   门店关联: ${venueWithCity[0].c}/${venueTotal[0].c}`);
    console.log(`   预约关联: ${resWithCity[0].c}/${resTotal[0].c}`);

    console.log('\n✅ 迁移完成!');
    await db.end();
}

migrate().catch(console.error);
