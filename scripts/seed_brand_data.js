import pool from '../src/db.js';

/**
 * 嘉美麓德婚礼公馆 — 完整种子数据
 *
 * 运行: npx tsx scripts/seed_brand_data.js
 *   或: cd dist && node scripts/seed_brand_data.js
 */

const OSS = 'https://creativepro.oss-cn-shanghai.aliyuncs.com/0305/images';

async function seed() {
    console.log('🚀 Starting Brand Data Seeding: 嘉美麓德婚礼公馆...\n');

    try {
        // ====== 1. 清理旧数据 ======
        await pool.execute('SET FOREIGN_KEY_CHECKS = 0');
        await pool.execute('DELETE FROM venue_image');
        await pool.execute('DELETE FROM case_image');
        await pool.execute('DELETE FROM wedding_case WHERE is_featured = 1');
        await pool.execute('DELETE FROM venue WHERE brand_id IS NOT NULL');
        await pool.execute('TRUNCATE TABLE brand');
        await pool.execute('SET FOREIGN_KEY_CHECKS = 1');

        // ====== 2. 品牌 ======
        const [brandResult] = await pool.execute(
            'INSERT INTO brand (name, slogan, description, contact_phone) VALUES (?, ?, ?, ?)',
            ['嘉美麓德婚礼公馆', '极致美学，定制婚礼', '嘉美麓德婚礼公馆提供一站式高端婚礼服务，涵盖婚宴、婚庆、生日宴及商务宴会。', '021-00000000']
        );
        const brandId = brandResult.insertId;
        console.log(`✅ Brand: 嘉美麓德婚礼公馆 (ID=${brandId})`);

        // ====== 3. 门店 ======
        const venues = [
            {
                name: '嘉美麓德婚礼公馆旗舰店',
                address: '静安区汶水路210号嘉美楼',
                phone: '021-00000001',
                city: '上海',
                lat: 31.2804,
                lng: 121.4537,
                business_hours: '09:00 - 21:00',
                metro_info: '地铁1号线3号口步行500米',
                description: '旗舰店坐落于静安核心地段，拥有多个不同风格的宴会厅，包括派乐殿、爱恋浓、百花时、教堂及草坪，可承办各类婚宴精致宴请。',
                cover_url: `${OSS}/sub_ynk_xr2pa_imgstylebg-1773508470287.jpg`,
                is_active: 1,
            },
            {
                name: '嘉美麓德婚礼公馆漕河泾臻选店',
                address: '闵行区漕宝路1625号6号楼',
                phone: '021-00000002',
                city: '上海',
                lat: 31.1684,
                lng: 121.3997,
                business_hours: '09:00 - 21:00',
                metro_info: '地铁9号线1号口步行500米',
                description: '漕河泾臻选店拥有精选宴会厅，包括裴宝刻、枫汀南及教堂，环境优雅别致，是举办浪漫婚礼的理想之选。',
                cover_url: `${OSS}/sub_8gxow27v9_src-1773508472637.jpg`,
                is_active: 1,
            },
            {
                name: '阿拉宫',
                address: '待定',
                phone: '',
                city: '上海',
                lat: null,
                lng: null,
                business_hours: '',
                metro_info: '',
                description: '阿拉宫（筹备中）',
                cover_url: '',
                is_active: 0, // 待定，不展示
            },
        ];

        const venueIds = {};
        for (const v of venues) {
            const [res] = await pool.execute(
                `INSERT INTO venue (name, brand_id, address, phone, city, lat, lng, business_hours, metro_info, description, cover_url, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [v.name, brandId, v.address, v.phone, v.city, v.lat, v.lng, v.business_hours, v.metro_info, v.description, v.cover_url, v.is_active]
            );
            venueIds[v.name] = res.insertId;
            console.log(`✅ Venue: ${v.name} (ID=${res.insertId}) ${v.is_active ? '' : '[待定]'}`);
        }

        const flagshipId = venueIds['嘉美麓德婚礼公馆旗舰店'];
        const caohejingId = venueIds['嘉美麓德婚礼公馆漕河泾臻选店'];

        // ====== 4. 门店环境轮播图 (venue_image) ======
        const venueImages = [
            // 旗舰店环境图
            { venue_id: flagshipId, url: `${OSS}/sub_ynk_xr2pa_imgstylebg-1773508470287.jpg` },
            { venue_id: flagshipId, url: `${OSS}/sub_ynk_xr2pa_imgstylebg-1773508470288.jpg` },
            { venue_id: flagshipId, url: `${OSS}/sub_ynk_xr2pa_imgstylebg-1773508470290.jpg` },
            // 漕河泾臻选店环境图
            { venue_id: caohejingId, url: `${OSS}/sub_8gxow27v9_src-1773508472637.jpg` },
            { venue_id: caohejingId, url: `${OSS}/sub_8gxow27v9_imgstylebg-1773508472637.jpg` },
            { venue_id: caohejingId, url: `${OSS}/sub_8gxow27v9_imgstylebg-1773508472636.jpg` },
        ];
        for (let i = 0; i < venueImages.length; i++) {
            await pool.execute(
                'INSERT INTO venue_image (venue_id, image_url, sort_order) VALUES (?, ?, ?)',
                [venueImages[i].venue_id, venueImages[i].url, i]
            );
        }
        console.log(`✅ Venue images: ${venueImages.length} 张`);

        // ====== 5. 宴会厅 (wedding_case, is_featured=1) ======
        const halls = [
            // ---- 旗舰店 5 个厅 ----
            {
                title: '派乐殿', hall_name: '派乐殿', venue_id: flagshipId,
                description: '派乐殿是旗舰店的标志性宴会厅，以法式宫廷风格打造，金色主调配合水晶吊灯，营造出至尊奢华的婚礼氛围。',
                cover_url: `${OSS}/sub_ynk_xr2pa_src-1773508470286.jpg`,
                images: [
                    `${OSS}/sub_ynk_xr2pa_src-1773508470286.jpg`,
                    `${OSS}/sub_ynk_xr2pa_imgstylebg-1773508470286.png`,
                    `${OSS}/sub_ynk_xr2pa_imgstylebg-1773508470287.jpg`,
                ],
            },
            {
                title: '爱恋浓', hall_name: '爱恋浓', venue_id: flagshipId,
                description: '爱恋浓以浪漫法式花园为灵感，花艺装饰与柔和灯光交相辉映，为您的婚礼增添一份浪漫与温馨。',
                cover_url: `${OSS}/sub_ynk_xr2pa_src-1773508470288.jpg`,
                images: [
                    `${OSS}/sub_ynk_xr2pa_src-1773508470288.jpg`,
                    `${OSS}/sub_ynk_xr2pa_imgstylebg-1773508470288.jpg`,
                    `${OSS}/sub_ynk_xr2pa_imgstylebg-1773508470290.jpg`,
                ],
            },
            {
                title: '百花时', hall_name: '百花时', venue_id: flagshipId,
                description: '百花时以四季花卉为主题，打造一个花团锦簇的梦幻宴会空间，让每一场婚礼都如花般绽放。',
                cover_url: `${OSS}/sub_ynk_xr2pa_src-1773508470291.jpg`,
                images: [
                    `${OSS}/sub_ynk_xr2pa_src-1773508470291.jpg`,
                    `${OSS}/sub_ynk_xr2pa_imgstylebg-1773508470291.jpg`,
                ],
            },
            {
                title: '教堂', hall_name: '教堂', venue_id: flagshipId,
                description: '旗舰店教堂以纯白色调配合穹顶设计，营造出圣洁庄重的婚礼仪式殿堂，是神圣婚礼的理想之选。',
                cover_url: `${OSS}/sub_proxyman_src-1773508477281.jpg`,
                images: [
                    `${OSS}/sub_proxyman_src-1773508477281.jpg`,
                    `${OSS}/sub_proxyman_imgstylebg-1773508477281.jpg`,
                    `${OSS}/sub_proxyman_imgstylebg-1773508477282.jpg`,
                ],
            },
            {
                title: '草坪', hall_name: '草坪', venue_id: flagshipId,
                description: '开阔的户外草坪场地，绿意盎然，适合举办清新自然的户外婚礼仪式与派对。',
                cover_url: `${OSS}/sub_1llqakbi1_imgstylebg-1773508474391.jpg`,
                images: [
                    `${OSS}/sub_1llqakbi1_imgstylebg-1773508474391.jpg`,
                    `${OSS}/sub_1llqakbi1_imgstylebg-1773508474390.jpg`,
                    `${OSS}/sub_1llqakbi1_src-1773508474391.png`,
                ],
            },
            // ---- 漕河泾臻选店 3 个厅 ----
            {
                title: '裴宝刻', hall_name: '裴宝刻', venue_id: caohejingId,
                description: '裴宝刻宴会厅以现代简约风格打造，空间通透明亮，适合时尚前卫的婚礼风格。',
                cover_url: `${OSS}/sub_8gxow27v9_src-1773508472636.jpg`,
                images: [
                    `${OSS}/sub_8gxow27v9_src-1773508472636.jpg`,
                    `${OSS}/sub_8gxow27v9_imgstylebg-1773508472636.jpg`,
                    `${OSS}/sub_8gxow27v9_src-1773508472637.jpg`,
                ],
            },
            {
                title: '枫汀南', hall_name: '枫汀南', venue_id: caohejingId,
                description: '枫汀南以温馨雅致的中式风格为主题，融合传统与现代美学，营造出典雅大气的婚宴空间。',
                cover_url: `${OSS}/sub_livina_imgstylebg-1773508465355.jpg`,
                images: [
                    `${OSS}/sub_livina_imgstylebg-1773508465355.jpg`,
                    `${OSS}/sub_livina_imgstylebg-1773508465355.png`,
                    `${OSS}/sub_livina_src-1773508465355.jpg`,
                ],
            },
            {
                title: '教堂', hall_name: '教堂', venue_id: caohejingId,
                description: '漕河泾臻选店教堂风格宴会厅，简约而不失庄重，为婚礼仪式增添神圣的氛围。',
                cover_url: `${OSS}/home_imgstylebg-1773508463347.png`,
                images: [
                    `${OSS}/home_imgstylebg-1773508463347.png`,
                    `${OSS}/home_src-1773508463348.jpg`,
                ],
            },
        ];

        for (const h of halls) {
            const [res] = await pool.execute(
                `INSERT INTO wedding_case (title, hall_name, venue_id, description, cover_url, is_featured, is_active, sort_order)
                 VALUES (?, ?, ?, ?, ?, 1, 1, 0)`,
                [h.title, h.hall_name, h.venue_id, h.description, h.cover_url]
            );
            const caseId = res.insertId;

            // 插入图集
            for (let i = 0; i < h.images.length; i++) {
                await pool.execute(
                    'INSERT INTO case_image (case_id, image_url, sort_order) VALUES (?, ?, ?)',
                    [caseId, h.images[i], i]
                );
            }
            console.log(`✅ Hall: ${h.hall_name} (ID=${caseId}, ${h.images.length} images)`);
        }

        // ====== 6. 套餐分类 (幂等) ======
        const categories = [
            { name: '婚宴菜单', slug: 'wedding_menu' },
            { name: '婚庆套餐', slug: 'wedding_pkg' },
            { name: '生日宴', slug: 'birthday' },
            { name: '商务年会', slug: 'business' },
        ];
        for (const cat of categories) {
            await pool.execute(
                'INSERT IGNORE INTO package_category (name, slug) VALUES (?, ?)',
                [cat.name, cat.slug]
            );
        }
        console.log(`✅ Package categories: ${categories.length} 个`);

        console.log('\n🎉 Seeding completed!');
    } catch (error) {
        console.error('❌ Seeding Failed:', error);
    } finally {
        process.exit();
    }
}

seed();
