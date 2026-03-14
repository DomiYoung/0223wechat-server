/**
 * 0305 CMS管理端 扩展路由
 *
 * 新增: 品牌管理、案例分类、套餐分类、套餐管理、页面配置、小程序用户
 * 前缀: /api/admin/
 */
import { Hono } from 'hono';
import pool from '../db.js';

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

    // 附带图集
    for (const row of rows) {
        const [imgs] = await pool.execute(
            'SELECT id, image_url, sort_order FROM package_image WHERE package_id = ? ORDER BY sort_order', [row.id]
        ) as any;
        row.images = imgs;
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

export default admin305;
