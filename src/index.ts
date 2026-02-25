import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import pool, { initDB } from './db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OSS from 'ali-oss';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = new Hono();

app.use('*', cors());

const ossClient = new OSS({
    region: process.env.ALIYUN_OSS_REGION || 'oss-cn-shanghai',
    accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET || '',
    bucket: process.env.ALIYUN_OSS_BUCKET || 'creativepro'
});

// ============================================================
// 静态文件 & 上传目录
// ============================================================
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

app.use('/uploads/*', serveStatic({ root: path.join(__dirname, '..') }));

// ============================================================
// 辅助函数
// ============================================================

/**
 * 通用分页参数解析
 * - page: 页码，最小 1
 * - pageSize: 每页条数，最小 1，最大 100
 */
function parsePagination(query: Record<string, string | undefined>): { page: number; pageSize: number; offset: number } {
    const page = Math.max(1, parseInt(query.page || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize || '20')));
    return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 构建分页响应格式
 */
function paginatedResponse(list: any[], total: number, page: number, pageSize: number) {
    return {
        code: 0,
        data: {
            list,
            pagination: {
                page,
                pageSize,
                total,
                totalPages: Math.ceil(total / pageSize),
            },
        },
    };
}

// ============================================================
// 认证中间件
// ============================================================
const authMiddleware = async (c: any, next: () => Promise<void>) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return c.json({ error: '未提供认证令牌' }, 401);
    if (!token.startsWith('admin-token-')) {
        return c.json({ error: '无效的认证令牌' }, 401);
    }
    await next();
};

// ============================================================
// 登录
// ============================================================
app.post('/api/admin/login', async (c) => {
    try {
        const { username, password } = await c.req.json();
        if (!username || !password) {
            return c.json({ error: '请提供用户名和密码' }, 400);
        }
        const [rows] = await pool.execute(
            'SELECT id, username, display_name, role FROM admin WHERE username = ? AND password_hash = ? AND is_active = 1',
            [username, password]
        ) as any;
        if (rows.length === 0) {
            return c.json({ error: '用户名或密码错误' }, 401);
        }
        const admin = rows[0];
        return c.json({
            code: 0,
            data: {
                token: `admin-token-${admin.id}`,
                admin: { id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role },
            },
        });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// ============================================================
// 城市管理 CRUD（聚合根）
// ============================================================

// 查询城市列表
app.get('/api/admin/cities', authMiddleware, async (c) => {
    try {
        const [rows] = await pool.execute(
            'SELECT id, name, region, sort_order, is_active, created_at FROM city ORDER BY sort_order, id'
        ) as any;
        return c.json({ code: 0, data: rows });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 公开接口：小程序获取已启用城市
app.get('/api/cities', async (c) => {
    try {
        const [rows] = await pool.execute(
            'SELECT id, name FROM city WHERE is_active = 1 ORDER BY sort_order, id'
        ) as any;
        return c.json({ code: 0, data: rows });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 新增城市
app.post('/api/admin/cities', authMiddleware, async (c) => {
    try {
        const { name, region, sort_order, is_active } = await c.req.json();
        if (!name) return c.json({ error: '城市名称不能为空' }, 400);
        const [result] = await pool.execute(
            'INSERT INTO city (name, region, sort_order, is_active) VALUES (?, ?, ?, ?)',
            [name, region || '', sort_order || 0, is_active ?? 1]
        ) as any;
        return c.json({ code: 0, data: { id: result.insertId } });
    } catch (err: any) {
        if (err.code === 'ER_DUP_ENTRY') return c.json({ error: '城市已存在' }, 409);
        return c.json({ error: err.message }, 500);
    }
});

// 更新城市
app.put('/api/admin/cities/:id', authMiddleware, async (c) => {
    try {
        const id = c.req.param('id');
        const { name, region, sort_order, is_active } = await c.req.json();
        await pool.execute(
            'UPDATE city SET name = COALESCE(?, name), region = COALESCE(?, region), sort_order = COALESCE(?, sort_order), is_active = COALESCE(?, is_active) WHERE id = ?',
            [name, region, sort_order, is_active, id]
        );
        return c.json({ code: 0 });
    } catch (err: any) {
        if (err.code === 'ER_DUP_ENTRY') return c.json({ error: '城市名称重复' }, 409);
        return c.json({ error: err.message }, 500);
    }
});

// 删除城市
app.delete('/api/admin/cities/:id', authMiddleware, async (c) => {
    try {
        const id = c.req.param('id');
        // 检查是否有关联门店
        const [venues] = await pool.execute('SELECT COUNT(*) as count FROM venue WHERE city_id = ?', [id]) as any;
        if (venues[0].count > 0) {
            return c.json({ error: `该城市下有 ${venues[0].count} 个门店，无法删除` }, 400);
        }
        await pool.execute('DELETE FROM city WHERE id = ?', [id]);
        return c.json({ code: 0 });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// ============================================================
// 门店管理 CRUD（带分页）
// ============================================================

// 查询门店
app.get('/api/admin/venues', authMiddleware, async (c) => {
    try {
        const { page, pageSize, offset } = parsePagination(c.req.query());
        const city = c.req.query('city');

        const conditions: string[] = [];
        const params: any[] = [];

        if (city && city !== 'all') {
            conditions.push('city = ?');
            params.push(city);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const [countResult] = await pool.execute(
            `SELECT COUNT(*) as total FROM venue ${whereClause}`,
            params
        ) as any;
        const total = countResult[0].total;

        const [rows] = await pool.execute(
            `SELECT * FROM venue ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, pageSize, offset]
        ) as any;

        return c.json(paginatedResponse(rows, total, page, pageSize));
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 新增门店
app.post('/api/admin/venues', authMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const { name, city, address, phone, cover_url, business_hours, is_active, lat, lng } = body;
        if (!name) return c.json({ error: '门店名称不能为空' }, 400);

        const [result] = await pool.execute(
            `INSERT INTO venue (name, city, address, phone, cover_url, business_hours, is_active, lat, lng)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, city || '', address || '', phone || '', cover_url || '', business_hours || '', is_active ?? 1, lat || null, lng || null]
        ) as any;

        return c.json({ code: 0, data: { id: result.insertId } });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 更新门店
app.put('/api/admin/venues/:id', authMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const { name, city, address, phone, cover_url, business_hours, is_active, lat, lng } = body;
        await pool.execute(
            `UPDATE venue SET name=?, city=?, address=?, phone=?, cover_url=?, business_hours=?, is_active=?, lat=?, lng=?
             WHERE id=?`,
            [name, city || '', address || '', phone || '', cover_url || '', business_hours || '', is_active ?? 1, lat || null, lng || null, c.req.param('id')]
        );
        return c.json({ code: 0 });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 删除门店
app.delete('/api/admin/venues/:id', authMiddleware, async (c) => {
    try {
        await pool.execute('DELETE FROM venue WHERE id = ?', [c.req.param('id')]);
        return c.json({ code: 0 });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// ============================================================
// 主题管理 CRUD（带分页 + 筛选 + 搜索）
// ============================================================

/**
 * 查询主题列表
 *
 * 查询参数:
 *   page, pageSize  — 分页
 *   city            — 按城市筛选（通过 venue JOIN）
 *   venueId         — 按门店ID筛选
 *   keyword         — 搜索主题名称/风格（参数化 LIKE，防注入）
 *   featured        — 筛选推荐 (1/0)
 *   active          — 筛选上线状态 (1/0)
 *
 * SQL 要点:
 *   - 所有用户输入使用 ? 占位符，防止 SQL 注入
 *   - LIKE 搜索使用 CONCAT('%', ?, '%')，关键词本身作为参数
 *   - LEFT JOIN venue 获取门店名和城市
 *   - 子查询获取图片数量，避免 GROUP BY 影响分页计数
 */
app.get('/api/admin/themes', authMiddleware, async (c) => {
    try {
        const query = c.req.query();
        const { page, pageSize, offset } = parsePagination(query);
        const city = query.city;
        const venueId = query.venueId;
        const keyword = query.keyword;
        const featured = query.featured;
        const active = query.active;

        // 动态构建 WHERE（参数化防注入）
        const conditions: string[] = [];
        const params: any[] = [];

        if (city && city !== 'all') {
            conditions.push('v.city = ?');
            params.push(city);
        }
        if (venueId) {
            conditions.push('wc.venue_id = ?');
            params.push(parseInt(venueId));
        }
        if (keyword) {
            conditions.push('(wc.title LIKE CONCAT(\'%\', ?, \'%\') OR wc.style LIKE CONCAT(\'%\', ?, \'%\'))');
            params.push(keyword, keyword);
        }
        if (featured !== undefined && featured !== '') {
            conditions.push('wc.is_featured = ?');
            params.push(parseInt(featured));
        }
        if (active !== undefined && active !== '') {
            conditions.push('wc.is_active = ?');
            params.push(parseInt(active));
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // 1. COUNT（使用相同 WHERE）
        const [countResult] = await pool.execute(
            `SELECT COUNT(*) as total
             FROM wedding_case wc
             LEFT JOIN venue v ON wc.venue_id = v.id
             ${whereClause}`,
            params
        ) as any;
        const total = countResult[0].total;

        // 2. 延迟关联分页（Deferred Join）
        //    先在索引上定位 ID（idx_sort_id 覆盖 ORDER BY sort_order, id）
        //    再用 ID 去 JOIN 获取完整数据 — 避免大 OFFSET 的全行扫描
        const [rows] = await pool.execute(
            `SELECT
                wc.*,
                v.name AS venue_name,
                v.city AS venue_city,
                (SELECT COUNT(*) FROM case_image ci WHERE ci.case_id = wc.id) AS image_count
             FROM wedding_case wc
             INNER JOIN (
                 SELECT wc2.id
                 FROM wedding_case wc2
                 LEFT JOIN venue v2 ON wc2.venue_id = v2.id
                 ${whereClause.replace(/\bv\./g, 'v2.').replace(/\bwc\./g, 'wc2.')}
                 ORDER BY wc2.sort_order ASC, wc2.id DESC
                 LIMIT ? OFFSET ?
             ) AS page_ids ON wc.id = page_ids.id
             LEFT JOIN venue v ON wc.venue_id = v.id
             ORDER BY wc.sort_order ASC, wc.id DESC`,
            [...params, pageSize, offset]
        ) as any;

        // 3. 批量获取当前页图片（IN 查询，非 N+1）
        if (rows.length > 0) {
            const caseIds = rows.map((r: any) => r.id);
            const placeholders = caseIds.map(() => '?').join(',');
            const [images] = await pool.execute(
                `SELECT * FROM case_image WHERE case_id IN (${placeholders}) ORDER BY sort_order ASC`,
                caseIds
            ) as any;

            const imageMap = new Map<number, any[]>();
            for (const img of images) {
                if (!imageMap.has(img.case_id)) imageMap.set(img.case_id, []);
                imageMap.get(img.case_id)!.push(img);
            }
            for (const row of rows) {
                row.images = imageMap.get(row.id) || [];
            }
        }

        return c.json(paginatedResponse(rows, total, page, pageSize));
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 新增主题
app.post('/api/admin/themes', authMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const { title, tag, style, wedding_date, shop_label, description, cover_url, venue_id, sort_order, is_featured, is_active, images } = body;
        if (!title) return c.json({ error: '主题名称不能为空' }, 400);

        const [result] = await pool.execute(
            `INSERT INTO wedding_case (title, tag, style, wedding_date, shop_label, description, cover_url, venue_id, sort_order, is_featured, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [title, tag || '', style || '', wedding_date || '', shop_label || '', description || '', cover_url || '', venue_id || null, sort_order || 0, is_featured || 0, is_active ?? 1]
        ) as any;

        const caseId = result.insertId;

        // 批量插入图片
        if (images && Array.isArray(images) && images.length > 0) {
            for (let i = 0; i < images.length; i++) {
                const url = images[i].image_url || images[i].url || images[i];
                await pool.execute(
                    'INSERT INTO case_image (case_id, image_url, sort_order) VALUES (?, ?, ?)',
                    [caseId, url, i]
                );
            }
        }

        return c.json({ code: 0, data: { id: caseId } });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 更新主题
app.put('/api/admin/themes/:id', authMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const id = c.req.param('id');
        const { title, tag, style, wedding_date, shop_label, description, cover_url, venue_id, sort_order, is_featured, is_active, images } = body;

        await pool.execute(
            `UPDATE wedding_case SET title=?, tag=?, style=?, wedding_date=?, shop_label=?, description=?, cover_url=?, venue_id=?, sort_order=?, is_featured=?, is_active=?
             WHERE id=?`,
            [title, tag || '', style || '', wedding_date || '', shop_label || '', description || '', cover_url || '', venue_id || null, sort_order || 0, is_featured || 0, is_active ?? 1, id]
        );

        // 更新图片：先删后插（事务安全由外键 CASCADE 保证）
        if (images && Array.isArray(images)) {
            await pool.execute('DELETE FROM case_image WHERE case_id = ?', [id]);
            for (let i = 0; i < images.length; i++) {
                const url = images[i].image_url || images[i].url || images[i];
                await pool.execute(
                    'INSERT INTO case_image (case_id, image_url, sort_order) VALUES (?, ?, ?)',
                    [id, url, i]
                );
            }
        }

        return c.json({ code: 0 });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 删除主题（图片由外键 CASCADE 自动删除）
app.delete('/api/admin/themes/:id', authMiddleware, async (c) => {
    try {
        await pool.execute('DELETE FROM wedding_case WHERE id = ?', [c.req.param('id')]);
        return c.json({ code: 0 });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// ============================================================
// 客资预约管理（带分页 + 筛选）
// ============================================================

/**
 * 查询预约列表
 * 支持参数: page, pageSize, status, keyword, city
 */
app.get('/api/admin/reservations', authMiddleware, async (c) => {
    try {
        const query = c.req.query();
        const { page, pageSize, offset } = parsePagination(query);
        const status = query.status;
        const keyword = query.keyword;
        const city = query.city;

        const conditions: string[] = [];
        const params: any[] = [];

        if (status && status !== 'all') {
            conditions.push('r.status = ?');
            params.push(status);
        }
        if (keyword) {
            conditions.push('(r.name LIKE CONCAT(\'%\', ?, \'%\') OR r.mobile LIKE CONCAT(\'%\', ?, \'%\'))');
            params.push(keyword, keyword);
        }
        if (city && city !== 'all') {
            conditions.push('r.city = ?');
            params.push(city);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const [countResult] = await pool.execute(
            `SELECT COUNT(*) as total FROM reservation r ${whereClause}`,
            params
        ) as any;
        const total = countResult[0].total;

        // 延迟关联：先在 idx_created 上定位 ID，再 JOIN 获取完整数据
        const [rows] = await pool.execute(
            `SELECT r.*, v.name AS venue_name, wc.title AS case_title
             FROM reservation r
             INNER JOIN (
                 SELECT r2.id FROM reservation r2
                 ${whereClause.replace(/\br\./g, 'r2.')}
                 ORDER BY r2.created_at DESC
                 LIMIT ? OFFSET ?
             ) AS page_ids ON r.id = page_ids.id
             LEFT JOIN venue v ON r.venue_id = v.id
             LEFT JOIN wedding_case wc ON r.case_id = wc.id
             ORDER BY r.created_at DESC`,
            [...params, pageSize, offset]
        ) as any;

        return c.json(paginatedResponse(rows, total, page, pageSize));
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 新增预约（小程序端调用，无需认证）
app.post('/api/reservation', async (c) => {
    try {
        const body = await c.req.json();
        const { name, mobile, wechat_openid, wedding_date, tables_count, venue_id, case_id, source, sub_platform, city } = body;
        if (!name || !mobile) return c.json({ error: '姓名和手机号不能为空' }, 400);

        const [result] = await pool.execute(
            `INSERT INTO reservation (name, mobile, wechat_openid, wedding_date, tables_count, venue_id, case_id, source, sub_platform, city)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, mobile, wechat_openid || null, wedding_date || '', tables_count || 0, venue_id || null, case_id || null, source || '小程序', sub_platform || '', city || '']
        ) as any;

        return c.json({ code: 0, data: { id: result.insertId } });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 更新预约状态（admin 跟进）
app.put('/api/admin/reservations/:id', authMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const { status, remark } = body;
        await pool.execute(
            'UPDATE reservation SET status = ?, remark = ? WHERE id = ?',
            [status, remark || '', c.req.param('id')]
        );
        return c.json({ code: 0 });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// ============================================================
// 小程序端 API（公开接口，无需认证）
// ============================================================

// 首页数据（公开，小程序 index 页面调用）
app.get('/api/home', async (c) => {
    try {
        // 获取推荐门店
        const [venues] = await pool.execute(
            `SELECT id, name, city, address, cover_url FROM venue WHERE is_active = 1 ORDER BY id LIMIT 6`
        ) as any;

        // 获取推荐案例
        const [cases] = await pool.execute(
            `SELECT wc.id, wc.title, wc.cover_url, wc.style, v.name AS venue_name, v.city
             FROM wedding_case wc
             LEFT JOIN venue v ON wc.venue_id = v.id
             WHERE wc.is_active = 1 AND wc.is_featured = 1
             ORDER BY wc.sort_order ASC, wc.id DESC
             LIMIT 6`
        ) as any;

        return c.json({ code: 0, data: { venues, cases } });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 获取门店列表（公开，小程序首页调用）
app.get('/api/venues', async (c) => {
    try {
        const city = c.req.query('city');
        const conditions: string[] = ['is_active = 1'];
        const params: any[] = [];

        if (city && city !== 'all') {
            conditions.push('city = ?');
            params.push(city);
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;
        const [rows] = await pool.execute(
            `SELECT id, name, city, address, phone, cover_url, business_hours, lat, lng
             FROM venue ${whereClause} ORDER BY city, id`,
            params
        ) as any;

        return c.json({ code: 0, data: rows });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 获取案例瀑布流（公开，live 页面调用）
app.get('/api/cases/live', async (c) => {
    try {
        const [rows] = await pool.execute(
            `SELECT wc.id, wc.title, wc.cover_url, wc.style, wc.tag,
                    v.name AS venue_name, v.city,
                    (SELECT GROUP_CONCAT(ci.image_url ORDER BY ci.sort_order SEPARATOR ',')
                     FROM case_image ci WHERE ci.case_id = wc.id) AS imgs
             FROM wedding_case wc
             LEFT JOIN venue v ON wc.venue_id = v.id
             WHERE wc.is_active = 1
             ORDER BY wc.is_featured DESC, wc.sort_order ASC, wc.id DESC
             LIMIT 50`
        ) as any;

        // 转换为小程序期望的格式
        const result = rows.map((row: any) => ({
            id: row.id,
            title: row.title,
            cover: row.cover_url,
            style: row.style,
            tag: row.tag,
            venue: row.venue_name,
            city: row.city,
            imgs: row.imgs ? row.imgs.split(',') : []
        }));

        return c.json({ code: 0, data: result });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 获取单个案例详情（公开，details 页面调用）
app.get('/api/cases/:id', async (c) => {
    try {
        const id = c.req.param('id');
        const [rows] = await pool.execute(
            `SELECT wc.*, v.name AS venue_name, v.city
             FROM wedding_case wc
             LEFT JOIN venue v ON wc.venue_id = v.id
             WHERE wc.id = ?`,
            [id]
        ) as any;

        if (rows.length === 0) {
            return c.json({ error: '案例不存在' }, 404);
        }

        const caseData = rows[0];

        // 获取图片列表
        const [images] = await pool.execute(
            `SELECT id, image_url, sort_order FROM case_image WHERE case_id = ? ORDER BY sort_order`,
            [id]
        ) as any;

        caseData.images = images;

        return c.json({ code: 0, data: caseData });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 提交预约（公开，小程序调用 /api/booking）
app.post('/api/booking', async (c) => {
    try {
        const body = await c.req.json();
        const { name, mobile, city, source, subPlatform, venue_id, case_id, wedding_date, tables_count } = body;
        if (!name || !mobile) return c.json({ error: '姓名和手机号不能为空' }, 400);

        const [result] = await pool.execute(
            `INSERT INTO reservation (name, mobile, city, source, sub_platform, venue_id, case_id, wedding_date, tables_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, mobile, city || '', source || '小程序', subPlatform || '', venue_id || null, case_id || null, wedding_date || '', tables_count || 0]
        ) as any;

        return c.json({ code: 0, data: { id: result.insertId } });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 获取门店+主题数据（兼容原始 shop.json 格式，保留备用）
app.get('/api/themes', async (c) => {
    try {
        // 一次性取出所有上线主题+门店+图片，避免 N+1 循环查询
        const [themes] = await pool.execute(
            `SELECT wc.id, wc.title, wc.cover_url, wc.sort_order,
                    v.name AS venue_name, v.city,
                    (SELECT GROUP_CONCAT(ci.image_url ORDER BY ci.sort_order)
                     FROM case_image ci WHERE ci.case_id = wc.id) AS image_urls
             FROM wedding_case wc
             INNER JOIN venue v ON wc.venue_id = v.id AND v.is_active = 1
             WHERE wc.is_active = 1
             ORDER BY v.city, wc.sort_order ASC`
        ) as any;

        const cityMap: Record<string, string> = { '上海': 'sh', '北京': 'bj', '南京': 'nj' };
        const result: Record<string, any[]> = {};

        for (const theme of themes) {
            const cityKey = cityMap[theme.city] || theme.city;
            if (!result[cityKey]) result[cityKey] = [];
            result[cityKey].push({
                index: theme.venue_name,
                title: theme.title,
                img: theme.cover_url,
                subPage: theme.image_urls
                    ? theme.image_urls.split(',').map((url: string) => ({ url }))
                    : [],
            });
        }

        return c.json(result);
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// ============================================================
// 文件上传（ali-oss）
// ============================================================
app.post('/api/upload', authMiddleware, async (c) => {
    try {
        const traceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const userAgent = c.req.header('user-agent') || '';
        const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '';
        const body = await c.req.parseBody();
        const file = body['file'];
        console.log(`[UPLOAD][${traceId}] receive request ip="${ip}" ua="${userAgent}" fields=${Object.keys(body).join(',')}`);
        if (!file || typeof file === 'string' || typeof (file as any).arrayBuffer !== 'function') {
            console.warn(`[UPLOAD][${traceId}] missing file field or invalid file payload`);
            return c.json({ error: '请选择文件' }, 400);
        }
        console.log(`[UPLOAD][${traceId}] file name="${file.name}" type="${file.type || 'unknown'}" size=${file.size}`);
        if (file.size <= 0) {
            console.warn(`[UPLOAD][${traceId}] file.size=0, possible macOS iCloud placeholder or incomplete sync`);
            return c.json({ error: '上传文件为空（0B），请重新选择图片' }, 400);
        }

        const ext = path.extname(file.name) || '.jpg';
        const fileName = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        const buffer = Buffer.from(await file.arrayBuffer());
        console.log(`[UPLOAD][${traceId}] buffer.length=${buffer.length}`);
        if (buffer.length <= 0) {
            console.warn(`[UPLOAD][${traceId}] buffer.length=0 after arrayBuffer(), possible local file read issue`);
            return c.json({ error: '读取上传文件失败（0B），请重试' }, 400);
        }

        const result = await ossClient.put(fileName, buffer, {
            headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'Content-Disposition': 'inline',
            },
        });
        if (!result?.url) {
            console.error(`[UPLOAD][${traceId}] oss put success but url missing for object="${fileName}"`);
            return c.json({ error: '上传成功但未获取到文件地址' }, 500);
        }
        const secureUrl = result.url.replace('http://', 'https://');
        console.log(`[UPLOAD][${traceId}] success object="${fileName}" url="${secureUrl}"`);

        return c.json({ code: 0, data: { url: secureUrl } });
    } catch (err: any) {
        console.error('[UPLOAD] unexpected error:', err);
        return c.json({ error: err.message }, 500);
    }
});

// ============================================================
// 启动
// ============================================================
const PORT = parseInt(process.env.PORT || '8199');

initDB()
    .then(() => {
        serve({
            fetch: app.fetch,
            port: PORT,
            hostname: '0.0.0.0',
        }, (info) => {
            console.log(`🚀 Wedding CMS API (Hono) running on http://0.0.0.0:${info.port}`);
        });
    })
    .catch((err) => {
        console.error('❌ 数据库初始化失败:', err);
        process.exit(1);
    });
