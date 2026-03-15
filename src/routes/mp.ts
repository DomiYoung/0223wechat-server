/**
 * 0305 小程序端 API 路由
 * 
 * 接口前缀: /api/mp/
 * JSON 响应格式保持与原版 0305 一致: { errcode, errmsg, data }
 */
import { Hono } from 'hono';
import pool from '../db.js';

const mp = new Hono();

// 统一响应格式 (兼容原版 0305)
const ok = (data: any = {}) => ({ errcode: 0, errmsg: 'success', data });
const fail = (msg: string, code = 500) => ({ errcode: code, errmsg: msg, data: {} });

// ============================================================
// 页面配置 (对应原版 POST /api3/zhan/xapp/page)
// ============================================================
mp.post('/page', async (c) => {
    try {
        const { pageKey, hash } = await c.req.json();
        const key = pageKey || hash || 'home';

        const [rows] = await pool.execute(
            'SELECT page_key, title, bg_color, elements_json, bottom_nav_json, music_url FROM page_config WHERE page_key = ? AND is_active = 1',
            [key]
        ) as any;

        if (rows.length === 0) {
            return c.json(ok({
                hash: key, pageId: key, title: '', backgroundColor: '#ffffff',
                elements: [], bottomNav: { show: false, data: {} }
            }));
        }

        const row = rows[0];
        return c.json(ok({
            hash: row.page_key,
            pageId: row.page_key,
            title: row.title || '',
            backgroundColor: row.bg_color || '#ffffff',
            musicInfo: row.music_url || null,
            elements: typeof row.elements_json === 'string' ? JSON.parse(row.elements_json) : (row.elements_json || []),
            bottomNav: typeof row.bottom_nav_json === 'string' ? JSON.parse(row.bottom_nav_json) : (row.bottom_nav_json || { show: false, data: {} }),
        }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 案例分类 (对应原版 POST /api3/zhan/xapp/getContentData)
// ============================================================
mp.post('/categories', async (c) => {
    try {
        const [categories] = await pool.execute(
            `SELECT cc.id, cc.name,
                    (SELECT COUNT(*) FROM wedding_case wc WHERE wc.category_id = cc.id AND wc.is_active = 1) as count
             FROM case_category cc
             WHERE cc.is_active = 1
             ORDER BY cc.sort_order, cc.id`
        ) as any;

        return c.json(ok({ categories }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 案例列表 (对应原版 POST /api3/zhan/xapp/getContentPageClassifyData)
// ============================================================
mp.post('/cases', async (c) => {
    try {
        const { categoryId, pageNum = 1, pageSize = 10 } = await c.req.json();
        const offset = (Math.max(1, pageNum) - 1) * Math.min(50, pageSize);

        const conditions: string[] = ['wc.is_active = 1'];
        const params: any[] = [];

        if (categoryId) {
            conditions.push('wc.category_id = ?');
            params.push(categoryId);
        }

        const where = conditions.join(' AND ');

        const [countRes] = await pool.execute(
            `SELECT COUNT(*) as total FROM wedding_case wc WHERE ${where}`, params
        ) as any;

        const [list] = await pool.execute(
            `SELECT wc.id, wc.title, wc.cover_url AS coverImgUrl, wc.views, wc.likes,
                    DATE_FORMAT(wc.created_at, '%Y-%m-%d') AS createTime
             FROM wedding_case wc
             WHERE ${where}
             ORDER BY wc.sort_order ASC, wc.id DESC
             LIMIT ? OFFSET ?`,
            [...params, Math.min(50, pageSize), offset]
        ) as any;

        return c.json(ok({ list, total: countRes[0].total }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 案例详情 (对应原版 POST /api3/zhan/xapp/getPageData)
// ============================================================
mp.post('/case/detail', async (c) => {
    try {
        const { id } = await c.req.json();
        if (!id) return c.json(fail('缺少案例ID', 400));

        // 增加浏览量
        await pool.execute('UPDATE wedding_case SET views = views + 1 WHERE id = ?', [id]);

        const [rows] = await pool.execute(
            `SELECT wc.id, wc.title, wc.content, wc.cover_url AS coverImgUrl,
                    wc.views, wc.likes, wc.description,
                    DATE_FORMAT(wc.created_at, '%Y-%m-%d') AS createTime,
                    v.name AS venueName, COALESCE(ct.name, v.city) AS city
             FROM wedding_case wc
             LEFT JOIN venue v ON wc.venue_id = v.id
             LEFT JOIN city ct ON v.city_id = ct.id
             WHERE wc.id = ? AND wc.is_active = 1`,
            [id]
        ) as any;

        if (rows.length === 0) return c.json(fail('案例不存在', 404));

        const caseData = rows[0];

        // 获取图集
        const [images] = await pool.execute(
            'SELECT image_url FROM case_image WHERE case_id = ? ORDER BY sort_order', [id]
        ) as any;
        caseData.images = images.map((i: any) => i.image_url);

        return c.json(ok({
            ...caseData,
            isLiked: false, // 需要用户系统后续实现
        }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 案例点赞 (对应原版 POST /api3/zhan/xapp/likeContentPage)
// ============================================================
mp.post('/case/like', async (c) => {
    try {
        const { id } = await c.req.json();
        await pool.execute('UPDATE wedding_case SET likes = likes + 1 WHERE id = ?', [id]);
        const [rows] = await pool.execute('SELECT likes FROM wedding_case WHERE id = ?', [id]) as any;
        return c.json(ok({ likes: rows[0]?.likes || 0 }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 套餐分类列表
// ============================================================
mp.post('/package-categories', async (c) => {
    try {
        const [categories] = await pool.execute(
            `SELECT id, name, slug, cover_url AS coverUrl
             FROM package_category
             WHERE is_active = 1
             ORDER BY sort_order, id`
        ) as any;
        return c.json(ok({ categories }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 套餐列表（按分类）
// ============================================================
mp.post('/packages', async (c) => {
    try {
        const { categoryId, slug, pageNum = 1, pageSize = 20 } = await c.req.json();
        const offset = (Math.max(1, pageNum) - 1) * Math.min(50, pageSize);

        const conditions: string[] = ['p.is_active = 1'];
        const params: any[] = [];

        if (categoryId) {
            conditions.push('p.category_id = ?');
            params.push(categoryId);
        } else if (slug) {
            conditions.push('pc.slug = ?');
            params.push(slug);
        }

        const where = conditions.join(' AND ');

        const [countRes] = await pool.execute(
            `SELECT COUNT(*) as total FROM package p LEFT JOIN package_category pc ON p.category_id = pc.id WHERE ${where}`, params
        ) as any;

        const [list] = await pool.execute(
            `SELECT p.id, p.title, p.cover_url AS coverUrl, p.price, p.price_label AS priceLabel,
                    p.tag, p.description, pc.name AS categoryName
             FROM package p
             LEFT JOIN package_category pc ON p.category_id = pc.id
             WHERE ${where}
             ORDER BY p.sort_order ASC, p.id DESC
             LIMIT ? OFFSET ?`,
            [...params, Math.min(50, pageSize), offset]
        ) as any;

        return c.json(ok({ list, total: countRes[0].total }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 套餐详情
// ============================================================
mp.post('/package/detail', async (c) => {
    try {
        const { id } = await c.req.json();
        if (!id) return c.json(fail('缺少套餐ID', 400));

        const [rows] = await pool.execute(
            `SELECT p.id, p.title, p.cover_url AS coverUrl, p.price, p.price_label AS priceLabel,
                    p.tag, p.description, pc.name AS categoryName
             FROM package p
             LEFT JOIN package_category pc ON p.category_id = pc.id
             WHERE p.id = ? AND p.is_active = 1`,
            [id]
        ) as any;

        if (rows.length === 0) return c.json(fail('套餐不存在', 404));

        const pkg = rows[0];

        const [images] = await pool.execute(
            'SELECT image_url FROM package_image WHERE package_id = ? ORDER BY sort_order', [id]
        ) as any;
        pkg.images = images.map((i: any) => i.image_url);

        return c.json(ok(pkg));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 门店列表（增强版：含品牌名、地铁信息、轮播图）
// ============================================================
mp.post('/venues', async (c) => {
    try {
        const body = await c.req.json().catch(() => ({}));
        const { cityId, brandId } = body as any;

        const conditions: string[] = ['v.is_active = 1'];
        const params: any[] = [];

        if (cityId) {
            conditions.push('v.city_id = ?');
            params.push(cityId);
        }
        if (brandId) {
            conditions.push('v.brand_id = ?');
            params.push(brandId);
        }

        const where = conditions.join(' AND ');

        const [list] = await pool.execute(
            `SELECT v.id, v.name, COALESCE(ct.name, v.city) AS city,
                    v.address, v.phone, v.cover_url AS coverUrl,
                    v.business_hours AS businessHours, v.lat, v.lng,
                    v.metro_info AS metroInfo, v.description,
                    b.name AS brandName
             FROM venue v
             LEFT JOIN city ct ON v.city_id = ct.id
             LEFT JOIN brand b ON v.brand_id = b.id
             WHERE ${where}
             ORDER BY v.brand_id, v.id`,
            params
        ) as any;

        // 附带每个门店的轮播图
        for (const venue of list) {
            const [imgs] = await pool.execute(
                'SELECT image_url FROM venue_image WHERE venue_id = ? ORDER BY sort_order',
                [venue.id]
            ) as any;
            venue.images = imgs.map((i: any) => i.image_url);
        }

        return c.json(ok({ list }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 门店详情（含宴会厅列表+轮播图）
// ============================================================
mp.post('/venue/detail', async (c) => {
    try {
        const { id } = await c.req.json();
        if (!id) return c.json(fail('缺少门店ID', 400));

        const [rows] = await pool.execute(
            `SELECT v.id, v.name, COALESCE(ct.name, v.city) AS city,
                    v.address, v.phone, v.cover_url AS coverUrl,
                    v.business_hours AS businessHours, v.lat, v.lng,
                    v.metro_info AS metroInfo, v.description,
                    b.name AS brandName
             FROM venue v
             LEFT JOIN city ct ON v.city_id = ct.id
             LEFT JOIN brand b ON v.brand_id = b.id
             WHERE v.id = ?`,
            [id]
        ) as any;

        if (rows.length === 0) return c.json(fail('门店不存在', 404));
        const venue = rows[0];

        // 轮播图
        const [imgs] = await pool.execute(
            'SELECT image_url FROM venue_image WHERE venue_id = ? ORDER BY sort_order', [id]
        ) as any;
        venue.images = imgs.map((i: any) => i.image_url);

        // 宴会厅列表
        const [halls] = await pool.execute(
            `SELECT wc.id, wc.title, wc.hall_name AS hallName, wc.cover_url AS coverUrl, wc.description
             FROM wedding_case wc
             WHERE wc.venue_id = ? AND wc.is_featured = 1 AND wc.is_active = 1
             ORDER BY wc.sort_order, wc.id`,
            [id]
        ) as any;
        venue.halls = halls;

        return c.json(ok(venue));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 宴会厅列表（按门店）
// ============================================================
mp.post('/venue/halls', async (c) => {
    try {
        const { venueId } = await c.req.json();
        if (!venueId) return c.json(fail('缺少门店ID', 400));

        const [list] = await pool.execute(
            `SELECT wc.id, wc.title, wc.hall_name AS hallName,
                    wc.cover_url AS coverUrl, wc.description
             FROM wedding_case wc
             WHERE wc.venue_id = ? AND wc.is_featured = 1 AND wc.is_active = 1
             ORDER BY wc.sort_order, wc.id`,
            [venueId]
        ) as any;

        // 附带每个厅的封面图（取第一张 case_image）
        for (const hall of list) {
            const [imgs] = await pool.execute(
                'SELECT image_url FROM case_image WHERE case_id = ? ORDER BY sort_order LIMIT 1',
                [hall.id]
            ) as any;
            if (imgs.length > 0 && !hall.coverUrl) {
                hall.coverUrl = imgs[0].image_url;
            }
        }

        return c.json(ok({ list }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 宴会厅详情（单个厅 + 图集）
// ============================================================
mp.post('/hall/detail', async (c) => {
    try {
        const { id } = await c.req.json();
        if (!id) return c.json(fail('缺少宴会厅ID', 400));

        const [rows] = await pool.execute(
            `SELECT wc.id, wc.title, wc.hall_name AS hallName,
                    wc.cover_url AS coverUrl, wc.description,
                    wc.tag, wc.wedding_date AS weddingDate,
                    v.name AS venueName, COALESCE(ct.name, v.city) AS city
             FROM wedding_case wc
             LEFT JOIN venue v ON wc.venue_id = v.id
             LEFT JOIN city ct ON v.city_id = ct.id
             WHERE wc.id = ? AND wc.is_active = 1`,
            [id]
        ) as any;

        if (rows.length === 0) return c.json(fail('宴会厅不存在', 404));

        const hall = rows[0];

        // 获取图集
        const [images] = await pool.execute(
            'SELECT image_url FROM case_image WHERE case_id = ? ORDER BY sort_order', [id]
        ) as any;
        hall.images = images.map((i: any) => i.image_url);

        return c.json(ok(hall));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 品牌信息
// ============================================================
mp.post('/brand', async (c) => {
    try {
        const [rows] = await pool.execute(
            'SELECT id, name, logo_url AS logoUrl, slogan, description, contact_phone AS contactPhone, contact_wechat AS contactWechat FROM brand WHERE is_active = 1 LIMIT 1'
        ) as any;

        return c.json(ok(rows[0] || {}));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 城市列表
// ============================================================
mp.post('/cities', async (c) => {
    try {
        const [list] = await pool.execute(
            'SELECT id, name FROM city WHERE is_active = 1 ORDER BY sort_order, id'
        ) as any;
        return c.json(ok({ list }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 表单提交 (对应原版 POST /api3/zhan/xapp/submit)
// 同时写入 reservation 表（兼容 0223 CRM 管理）
// ============================================================
mp.post('/submit', async (c) => {
    try {
        const body = await c.req.json();
        const { formId, pageId, phone, data: fields } = body;

        // 1. 写入 lead_submit 主表
        const [submitResult] = await pool.execute(
            `INSERT INTO lead_submit (
                pid, zhan_id, wid, uwid, open_id, form_id, page_id,
                submit_type, channel_id, phone, raw_payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                body.pid || '', body.zhanId || '', body.wid || '', body.uwid || '',
                body.openId || '', formId || '', pageId || '',
                Number(body.submitType || 0), Number(body.channelId || 0),
                phone || '',
                JSON.stringify(body)
            ]
        ) as any;

        const submitId = submitResult.insertId;

        // 2. 写入 lead_submit_field 子表
        if (Array.isArray(fields) && fields.length > 0) {
            for (let i = 0; i < fields.length; i++) {
                const item = fields[i];
                await pool.execute(
                    `INSERT INTO lead_submit_field (submit_id, field_key, label, mark, mode, value_json, show_value, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        submitId,
                        item.fieldKey || item.name || '',
                        item.label || '',
                        item.mark || '',
                        String(item.mode || ''),
                        item.value !== undefined ? JSON.stringify(item.value) : null,
                        item.showValue || (typeof item.value === 'string' ? item.value : ''),
                        i
                    ]
                );
            }
        }

        // 3. 同时写入 reservation (如果包含姓名和手机号)
        const nameField = Array.isArray(fields) ? fields.find((f: any) => f.fieldKey === 'name' || f.mark === 'name') : null;
        const phoneField = Array.isArray(fields) ? fields.find((f: any) => f.fieldKey === 'phone' || f.mark === 'phone') : null;
        const dateField = Array.isArray(fields) ? fields.find((f: any) => f.fieldKey === 'date' || f.mark === 'date') : null;

        if (nameField && (phoneField || phone)) {
            const nameVal = nameField.showValue || nameField.value || '';
            const phoneVal = phoneField?.showValue || phoneField?.value || phone || '';
            const dateVal = dateField?.showValue || dateField?.value || '';

            await pool.execute(
                `INSERT INTO reservation (name, mobile, wedding_date, source, lead_meta)
                 VALUES (?, ?, ?, ?, ?)`,
                [nameVal, phoneVal, dateVal, '小程序-0305', JSON.stringify({ formId, pageId, submitId })]
            );
        }

        return c.json(ok({ formId: String(submitId) }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 分享海报 (对应原版 POST /api3/zhan/xapp/watermark)
// ============================================================
mp.post('/watermark', async (c) => {
    try {
        return c.json(ok({ imgUrl: '' }));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

export default mp;
