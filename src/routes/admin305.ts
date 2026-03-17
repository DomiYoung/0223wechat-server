/**
 * 0305 CMS管理端 扩展路由
 *
 * 新增: 品牌管理、案例分类、套餐分类、套餐管理、页面配置、小程序用户
 * 前缀: /api/admin/
 */
import { Hono } from 'hono';
import pool from '../db.js';
import { processBulkUpload } from '../services/bulk-upload.service.js';

const admin305 = new Hono();

// ============================================================
// 品牌管理 (brand)
// ============================================================
admin305.get('/brands', async (c) => {
    const [rows] = await pool.execute('SELECT * FROM brand ORDER BY id') as any;
    return c.json({ code: 0, data: rows });
});

admin305.post('/brands', async (c) => {
    const { name, logo_url, slogan, description, contact_phone, contact_wechat } = await c.req.json();
    const [result] = await pool.execute(
        'INSERT INTO brand (name, logo_url, slogan, description, contact_phone, contact_wechat) VALUES (?, ?, ?, ?, ?, ?)',
        [name, logo_url || null, slogan || '', description || '', contact_phone || '', contact_wechat || '']
    ) as any;
    return c.json({ code: 0, data: { id: result.insertId } });
});

admin305.put('/brands/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const fields = ['name', 'logo_url', 'slogan', 'description', 'contact_phone', 'contact_wechat', 'is_active'];
    const sets: string[] = [];
    const params: any[] = [];

    for (const f of fields) {
        if (body[f] !== undefined) {
            sets.push(`${f} = ?`);
            params.push(body[f]);
        }
    }
    if (sets.length === 0) return c.json({ error: '无可更新字段' }, 400);

    params.push(id);
    await pool.execute(`UPDATE brand SET ${sets.join(', ')} WHERE id = ?`, params);
    return c.json({ code: 0 });
});

admin305.delete('/brands/:id', async (c) => {
    await pool.execute('DELETE FROM brand WHERE id = ?', [c.req.param('id')]);
    return c.json({ code: 0 });
});

// ============================================================
// 案例分类管理 (case_category)
// ============================================================
admin305.get('/case-categories', async (c) => {
    const [rows] = await pool.execute('SELECT * FROM case_category ORDER BY sort_order, id') as any;
    return c.json({ code: 0, data: rows });
});

admin305.post('/case-categories', async (c) => {
    const { name, sort_order } = await c.req.json();
    const [result] = await pool.execute(
        'INSERT INTO case_category (name, sort_order) VALUES (?, ?)',
        [name, sort_order || 0]
    ) as any;
    return c.json({ code: 0, data: { id: result.insertId } });
});

admin305.put('/case-categories/:id', async (c) => {
    const { name, sort_order, is_active } = await c.req.json();
    await pool.execute(
        'UPDATE case_category SET name = ?, sort_order = ?, is_active = ? WHERE id = ?',
        [name, sort_order || 0, is_active ?? 1, c.req.param('id')]
    );
    return c.json({ code: 0 });
});

admin305.delete('/case-categories/:id', async (c) => {
    await pool.execute('DELETE FROM case_category WHERE id = ?', [c.req.param('id')]);
    return c.json({ code: 0 });
});

// ============================================================
// 套餐分类管理 (package_category)
// ============================================================
admin305.get('/package-categories', async (c) => {
    const [rows] = await pool.execute('SELECT * FROM package_category ORDER BY sort_order, id') as any;
    return c.json({ code: 0, data: rows });
});

admin305.post('/package-categories', async (c) => {
    const { name, slug, cover_url, sort_order } = await c.req.json();
    const [result] = await pool.execute(
        'INSERT INTO package_category (name, slug, cover_url, sort_order) VALUES (?, ?, ?, ?)',
        [name, slug || null, cover_url || null, sort_order || 0]
    ) as any;
    return c.json({ code: 0, data: { id: result.insertId } });
});

admin305.put('/package-categories/:id', async (c) => {
    const body = await c.req.json();
    const fields = ['name', 'slug', 'cover_url', 'sort_order', 'is_active'];
    const sets: string[] = [];
    const params: any[] = [];

    for (const f of fields) {
        if (body[f] !== undefined) {
            sets.push(`${f} = ?`);
            params.push(body[f]);
        }
    }
    if (sets.length === 0) return c.json({ error: '无可更新字段' }, 400);

    params.push(c.req.param('id'));
    await pool.execute(`UPDATE package_category SET ${sets.join(', ')} WHERE id = ?`, params);
    return c.json({ code: 0 });
});

admin305.delete('/package-categories/:id', async (c) => {
    await pool.execute('DELETE FROM package_category WHERE id = ?', [c.req.param('id')]);
    return c.json({ code: 0 });
});

// ============================================================
// 套餐管理 (package)
// ============================================================
admin305.get('/packages', async (c) => {
    const categoryId = c.req.query('categoryId');
    let sql = `SELECT p.*, pc.name AS category_name FROM package p LEFT JOIN package_category pc ON p.category_id = pc.id`;
    const params: any[] = [];

    if (categoryId) {
        sql += ' WHERE p.category_id = ?';
        params.push(categoryId);
    }
    sql += ' ORDER BY p.sort_order ASC, p.id DESC';

    const [rows] = await pool.execute(sql, params) as any;

    // 附带图集（批量查询，避免 N+1）
    if (rows.length > 0) {
        const pkgIds = rows.map((r: any) => r.id);
        const placeholders = pkgIds.map(() => '?').join(',');
        const [imgs] = await pool.execute(
            `SELECT id, package_id, image_url, sort_order
             FROM package_image
             WHERE package_id IN (${placeholders})
             ORDER BY package_id, sort_order`,
            pkgIds
        ) as any;

        const imgMap = new Map<number, any[]>();
        for (const img of imgs) {
            if (!imgMap.has(img.package_id)) imgMap.set(img.package_id, []);
            imgMap.get(img.package_id)!.push(img);
        }
        for (const row of rows) {
            row.images = imgMap.get(row.id) || [];
        }
    }

    return c.json({ code: 0, data: rows });
});

admin305.post('/packages', async (c) => {
    const { category_id, title, cover_url, price, price_label, tag, description, sort_order, images } = await c.req.json();
    if (!category_id || !title) return c.json({ error: '分类和标题必填' }, 400);

    const [result] = await pool.execute(
        `INSERT INTO package (category_id, title, cover_url, price, price_label, tag, description, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [category_id, title, cover_url || null, price || null, price_label || '', tag || '', description || '', sort_order || 0]
    ) as any;

    const pkgId = result.insertId;

    // 插入图集
    if (Array.isArray(images) && images.length > 0) {
        for (let i = 0; i < images.length; i++) {
            await pool.execute(
                'INSERT INTO package_image (package_id, image_url, sort_order) VALUES (?, ?, ?)',
                [pkgId, images[i].image_url || images[i].url || images[i], i]
            );
        }
    }

    return c.json({ code: 0, data: { id: pkgId } });
});

admin305.put('/packages/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const fields = ['category_id', 'title', 'cover_url', 'price', 'price_label', 'tag', 'description', 'sort_order', 'is_active'];
    const sets: string[] = [];
    const params: any[] = [];

    for (const f of fields) {
        if (body[f] !== undefined) {
            sets.push(`${f} = ?`);
            params.push(body[f]);
        }
    }

    if (sets.length > 0) {
        params.push(id);
        await pool.execute(`UPDATE package SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    // 图集更新 (先删后插)
    if (Array.isArray(body.images)) {
        await pool.execute('DELETE FROM package_image WHERE package_id = ?', [id]);
        for (let i = 0; i < body.images.length; i++) {
            const img = body.images[i];
            await pool.execute(
                'INSERT INTO package_image (package_id, image_url, sort_order) VALUES (?, ?, ?)',
                [id, img.image_url || img.url || img, i]
            );
        }
    }

    return c.json({ code: 0 });
});

admin305.delete('/packages/:id', async (c) => {
    await pool.execute('DELETE FROM package WHERE id = ?', [c.req.param('id')]);
    return c.json({ code: 0 });
});

// ============================================================
// 页面配置管理 (page_config)
// ============================================================
admin305.get('/pages', async (c) => {
    const [rows] = await pool.execute('SELECT id, page_key, title, bg_color, is_active, updated_at FROM page_config ORDER BY id') as any;
    return c.json({ code: 0, data: rows });
});

admin305.get('/pages/:key', async (c) => {
    const [rows] = await pool.execute('SELECT * FROM page_config WHERE page_key = ?', [c.req.param('key')]) as any;
    if (rows.length === 0) return c.json({ error: '页面不存在' }, 404);

    const row = rows[0];
    row.elements_json = typeof row.elements_json === 'string' ? JSON.parse(row.elements_json) : row.elements_json;
    row.bottom_nav_json = typeof row.bottom_nav_json === 'string' ? JSON.parse(row.bottom_nav_json) : row.bottom_nav_json;
    return c.json({ code: 0, data: row });
});

admin305.post('/pages', async (c) => {
    const { page_key, title, bg_color, elements_json, bottom_nav_json, music_url } = await c.req.json();
    if (!page_key) return c.json({ error: 'page_key必填' }, 400);

    const [result] = await pool.execute(
        `INSERT INTO page_config (page_key, title, bg_color, elements_json, bottom_nav_json, music_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [page_key, title || '', bg_color || '#ffffff', JSON.stringify(elements_json || []),
         JSON.stringify(bottom_nav_json || {}), music_url || null]
    ) as any;

    return c.json({ code: 0, data: { id: result.insertId } });
});

admin305.put('/pages/:key', async (c) => {
    const key = c.req.param('key');
    const body = await c.req.json();

    const sets: string[] = [];
    const params: any[] = [];

    if (body.title !== undefined) { sets.push('title = ?'); params.push(body.title); }
    if (body.bg_color !== undefined) { sets.push('bg_color = ?'); params.push(body.bg_color); }
    if (body.music_url !== undefined) { sets.push('music_url = ?'); params.push(body.music_url); }
    if (body.is_active !== undefined) { sets.push('is_active = ?'); params.push(body.is_active); }
    if (body.elements_json !== undefined) {
        sets.push('elements_json = ?');
        params.push(JSON.stringify(body.elements_json));
    }
    if (body.bottom_nav_json !== undefined) {
        sets.push('bottom_nav_json = ?');
        params.push(JSON.stringify(body.bottom_nav_json));
    }

    if (sets.length === 0) return c.json({ error: '无可更新字段' }, 400);

    params.push(key);
    await pool.execute(`UPDATE page_config SET ${sets.join(', ')} WHERE page_key = ?`, params);
    return c.json({ code: 0 });
});

// ============================================================
// 小程序用户列表 (wx_user)
// ============================================================
admin305.get('/wx-users', async (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const pageSize = Math.min(50, parseInt(c.req.query('pageSize') || '20'));
    const offset = (page - 1) * pageSize;

    const [countRes] = await pool.execute('SELECT COUNT(*) as total FROM wx_user') as any;
    const [rows] = await pool.execute(
        'SELECT id, openid, nickname, avatar_url, phone, created_at FROM wx_user ORDER BY id DESC LIMIT ? OFFSET ?',
        [pageSize, offset]
    ) as any;

    return c.json({ code: 0, data: { list: rows, total: countRes[0].total, page, pageSize } });
});

// ============================================================
// 门店管理 (CRUD with new fields)
// ============================================================
admin305.get('/venues', async (c) => {
    const [rows] = await pool.execute(
        `SELECT v.*, b.name AS brandName FROM venue v LEFT JOIN brand b ON v.brand_id = b.id ORDER BY v.id`
    ) as any;

    // 附带每个门店的轮播图 + 宴会厅数量（批量查询，避免 N+1）
    if (rows.length > 0) {
        const venueIds = rows.map((v: any) => v.id);
        const placeholders = venueIds.map(() => '?').join(',');

        const [imgs] = await pool.execute(
            `SELECT id, venue_id, image_url, sort_order
             FROM venue_image
             WHERE venue_id IN (${placeholders})
             ORDER BY venue_id, sort_order`,
            venueIds
        ) as any;
        const imgMap = new Map<number, any[]>();
        for (const img of imgs) {
            if (!imgMap.has(img.venue_id)) imgMap.set(img.venue_id, []);
            imgMap.get(img.venue_id)!.push(img);
        }

        const [hallCounts] = await pool.execute(
            `SELECT venue_id, COUNT(*) as cnt
             FROM wedding_case
             WHERE is_featured = 1 AND venue_id IN (${placeholders})
             GROUP BY venue_id`,
            venueIds
        ) as any;
        const hallCountMap = new Map<number, number>();
        for (const r of hallCounts) hallCountMap.set(r.venue_id, Number(r.cnt || 0));

        for (const v of rows) {
            v.images = imgMap.get(v.id) || [];
            v.hallCount = hallCountMap.get(v.id) || 0;
        }
    }
    return c.json({ code: 0, data: { list: rows } });
});

admin305.put('/venue/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const allowed = ['name', 'address', 'phone', 'city', 'lat', 'lng', 'business_hours', 'metro_info', 'description', 'cover_url', 'is_active', 'brand_id'];
    const sets: string[] = [];
    const params: any[] = [];
    for (const key of allowed) {
        if (body[key] !== undefined) {
            sets.push(`${key} = ?`);
            params.push(body[key]);
        }
    }
    if (sets.length === 0) return c.json({ code: 400, msg: 'No fields to update' });
    params.push(id);
    await pool.execute(`UPDATE venue SET ${sets.join(', ')} WHERE id = ?`, params);
    return c.json({ code: 0 });
});

admin305.post('/venue', async (c) => {
    const body = await c.req.json();
    const { name, address, phone, city, brand_id, metro_info, description, cover_url } = body;
    const [res] = await pool.execute(
        `INSERT INTO venue (name, address, phone, city, brand_id, metro_info, description, cover_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, address || '', phone || '', city || '上海', brand_id || null, metro_info || '', description || '', cover_url || '']
    ) as any;
    return c.json({ code: 0, data: { id: res.insertId } });
});

// ============================================================
// 门店环境图集 (venue_image CRUD)
// ============================================================
admin305.get('/venue-images/:venueId', async (c) => {
    const venueId = c.req.param('venueId');
    const [rows] = await pool.execute(
        'SELECT id, venue_id, image_url, sort_order FROM venue_image WHERE venue_id = ? ORDER BY sort_order',
        [venueId]
    ) as any;
    return c.json({ code: 0, data: { list: rows } });
});

admin305.post('/venue-image', async (c) => {
    const { venue_id, image_url, sort_order } = await c.req.json();
    if (!venue_id || !image_url) return c.json({ code: 400, msg: 'venue_id and image_url required' });
    const [res] = await pool.execute(
        'INSERT INTO venue_image (venue_id, image_url, sort_order) VALUES (?, ?, ?)',
        [venue_id, image_url, sort_order || 0]
    ) as any;
    return c.json({ code: 0, data: { id: res.insertId } });
});

admin305.delete('/venue-image/:id', async (c) => {
    const id = c.req.param('id');
    await pool.execute('DELETE FROM venue_image WHERE id = ?', [id]);
    return c.json({ code: 0 });
});

// ============================================================
// 宴会厅管理 (基于 wedding_case, is_featured=1)
// ============================================================
admin305.get('/venue-halls/:venueId', async (c) => {
    const venueId = c.req.param('venueId');
    const [rows] = await pool.execute(
        `SELECT wc.id, wc.title, wc.hall_name, wc.cover_url, wc.description, wc.is_active, wc.sort_order,
                v.name AS venueName
         FROM wedding_case wc
         LEFT JOIN venue v ON wc.venue_id = v.id
         WHERE wc.venue_id = ? AND wc.is_featured = 1
         ORDER BY wc.sort_order, wc.id`,
        [venueId]
    ) as any;

    // 附带每个厅的图片数（批量查询，避免 N+1）
    if (rows.length > 0) {
        const hallIds = rows.map((h: any) => h.id);
        const placeholders = hallIds.map(() => '?').join(',');
        const [counts] = await pool.execute(
            `SELECT case_id, COUNT(*) as cnt
             FROM case_image
             WHERE case_id IN (${placeholders})
             GROUP BY case_id`,
            hallIds
        ) as any;
        const countMap = new Map<number, number>();
        for (const r of counts) countMap.set(r.case_id, Number(r.cnt || 0));
        for (const h of rows) h.imageCount = countMap.get(h.id) || 0;
    }
    return c.json({ code: 0, data: { list: rows } });
});

admin305.post('/venue-hall', async (c) => {
    const body = await c.req.json();
    const { title, hall_name, venue_id, description, cover_url } = body;
    if (!venue_id || !hall_name) return c.json({ code: 400, msg: 'venue_id and hall_name required' });
    const [res] = await pool.execute(
        `INSERT INTO wedding_case (title, hall_name, venue_id, description, cover_url, is_featured, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, 1, 1, 0)`,
        [title || hall_name, hall_name, venue_id, description || '', cover_url || '']
    ) as any;
    return c.json({ code: 0, data: { id: res.insertId } });
});

admin305.put('/venue-hall/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const allowed = ['title', 'hall_name', 'description', 'cover_url', 'is_active', 'sort_order', 'venue_id'];
    const sets: string[] = [];
    const params: any[] = [];
    for (const key of allowed) {
        if (body[key] !== undefined) {
            sets.push(`${key} = ?`);
            params.push(body[key]);
        }
    }
    if (sets.length === 0) return c.json({ code: 400, msg: 'No fields to update' });
    params.push(id);
    await pool.execute(`UPDATE wedding_case SET ${sets.join(', ')} WHERE id = ?`, params);
    return c.json({ code: 0 });
});

admin305.delete('/venue-hall/:id', async (c) => {
    const id = c.req.param('id');
    // 同时删除关联图片
    await pool.execute('DELETE FROM case_image WHERE case_id = ?', [id]);
    await pool.execute('DELETE FROM wedding_case WHERE id = ? AND is_featured = 1', [id]);
    return c.json({ code: 0 });
});

// ============================================================
// 素材批量处理上传 (Bulk Upload ZIP)
// ============================================================
admin305.post('/bulk-upload', async (c) => {
    try {
        const body = await c.req.parseBody();
        const file = body['file'] as File;

        if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
            return c.json({ error: '请选择.zip压缩包文件' }, 400);
        }

        if (!file.name.endsWith('.zip')) {
            return c.json({ error: '仅支持.zip格式的文件上传' }, 400);
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        // Do processing
        const report = await processBulkUpload(buffer);

        return c.json({ code: 0, data: { report } });
    } catch (err: any) {
        console.error('[Admin305] bulk upload failed:', err);
        return c.json({ error: err.message }, 500);
    }
});

// ============================================================
// 短信发送记录管理
// ============================================================

/**
 * 查询短信发送记录列表
 * GET /api/admin/sms-logs?page=1&limit=20&status=success&phone=139
 */
admin305.get('/sms-logs', async (c) => {
    try {
        const page = parseInt(c.req.query('page') || '1');
        const limit = parseInt(c.req.query('limit') || '20');
        const status = c.req.query('status') || ''; // success/failed/all
        const phone = c.req.query('phone') || '';
        const startDate = c.req.query('startDate') || '';
        const endDate = c.req.query('endDate') || '';

        const offset = (page - 1) * limit;

        // 构建查询条件
        const conditions: string[] = [];
        const params: any[] = [];

        if (status && status !== 'all') {
            conditions.push('status = ?');
            params.push(status);
        }

        if (phone) {
            conditions.push('phone LIKE ?');
            params.push(`%${phone}%`);
        }

        if (startDate) {
            conditions.push('created_at >= ?');
            params.push(startDate);
        }

        if (endDate) {
            conditions.push('created_at <= ?');
            params.push(`${endDate} 23:59:59`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // 查询总数
        const [countRows] = await pool.execute(
            `SELECT COUNT(*) as total FROM sms_log ${whereClause}`,
            params
        ) as any;

        const total = countRows[0].total;

        // 查询列表
        const [rows] = await pool.execute(
            `SELECT id, phone, template_code, template_param, biz_id, status, error_message, created_at
             FROM sms_log
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        ) as any;

        return c.json({
            code: 0,
            data: {
                list: rows,
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err: any) {
        return c.json({ code: 1, message: err.message }, 500);
    }
});

/**
 * 查询短信发送统计
 * GET /api/admin/sms-stats?startDate=2026-03-01&endDate=2026-03-15
 */
admin305.get('/sms-stats', async (c) => {
    try {
        const startDate = c.req.query('startDate') || '';
        const endDate = c.req.query('endDate') || '';

        const conditions: string[] = [];
        const params: any[] = [];

        if (startDate) {
            conditions.push('created_at >= ?');
            params.push(startDate);
        }

        if (endDate) {
            conditions.push('created_at <= ?');
            params.push(`${endDate} 23:59:59`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // 统计总数、成功数、失败数
        const [statsRows] = await pool.execute(
            `SELECT
               COUNT(*) as total,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
             FROM sms_log
             ${whereClause}`,
            params
        ) as any;

        // 按模板统计
        const [templateRows] = await pool.execute(
            `SELECT
               template_code,
               COUNT(*) as count,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count
             FROM sms_log
             ${whereClause}
             GROUP BY template_code
             ORDER BY count DESC`,
            params
        ) as any;

        // 按日期统计（最近7天）
        const [dailyRows] = await pool.execute(
            `SELECT
               DATE(created_at) as date,
               COUNT(*) as count,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count
             FROM sms_log
             ${whereClause}
             GROUP BY DATE(created_at)
             ORDER BY date DESC
             LIMIT 7`,
            params
        ) as any;

        return c.json({
            code: 0,
            data: {
                summary: statsRows[0],
                byTemplate: templateRows,
                byDate: dailyRows
            }
        });
    } catch (err: any) {
        return c.json({ code: 1, message: err.message }, 500);
    }
});

/**
 * 查询单条短信详情
 * GET /api/admin/sms-logs/:id
 */
admin305.get('/sms-logs/:id', async (c) => {
    try {
        const id = c.req.param('id');

        const [rows] = await pool.execute(
            'SELECT * FROM sms_log WHERE id = ?',
            [id]
        ) as any;

        if (rows.length === 0) {
            return c.json({ code: 404, message: '记录不存在' }, 404);
        }

        return c.json({ code: 0, data: rows[0] });
    } catch (err: any) {
        return c.json({ code: 1, message: err.message }, 500);
    }
});

export default admin305;
