import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import pool from './db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OSS from 'ali-oss';
import { queryThemes, toPublicTheme, toPublicThemeDetail, toAdminTheme } from './services/theme.service.js';
import mpRoutes from './routes/mp.js';
import admin305Routes from './routes/admin305.js';
import api3Routes from './routes/api3.js';
import { startMessageTaskWorker } from './services/message-task.service.js';
import { forget, forgetByPrefix } from './response-cache.js';
import { adminAuthMiddleware } from './middleware/admin-auth.js';
import { hashAdminPassword, issueAdminToken, verifyAdminPassword } from './security/admin-auth.js';
import { getWechatConfig } from './services/wechat-config.js';
import { appLogger, requestLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = new Hono();
const log = appLogger.child({ module: 'index' });

function invalidateCityCaches() {
    forget('cities:v1');
    forgetByPrefix('venues:v1:');
}

app.use('*', requestLogger);

const corsAllowedOrigins = new Set(
    [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173',
        ...(process.env.CORS_ORIGIN_WHITELIST || '')
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean),
    ]
);

app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    const requestPath = c.req.path || '';
    const isAdminCors = requestPath.startsWith('/api/admin') || requestPath === '/api/upload';
    const isAllowedOrigin = !!origin && corsAllowedOrigins.has(origin);

    if (c.req.method === 'OPTIONS') {
        // Public endpoints: permissive CORS (same as historical behavior).
        if (!isAdminCors) {
            c.header('Access-Control-Allow-Origin', '*');
            c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
            c.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
            c.header('Access-Control-Max-Age', '86400');
            return c.body(null, 204);
        }

        // Admin endpoints: origin allowlist.
        if (!origin || !isAllowedOrigin) return c.body(null, 403);
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        c.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
        c.header('Access-Control-Max-Age', '86400');
        c.header('Vary', 'Origin');
        return c.body(null, 204);
    }

    await next();

    if (!isAdminCors) {
        c.header('Access-Control-Allow-Origin', '*');
        c.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
        return;
    }

    if (isAllowedOrigin) {
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
        c.header('Vary', 'Origin');
    }
});

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

app.onError((err, c) => {
    log.error({ err, method: c.req.method, url: c.req.url }, 'global error');
    return c.json({ errcode: 500, errmsg: err.message }, 500);
});

app.use('/uploads/*', serveStatic({ root: './' }));
app.use('/assets/*', serveStatic({ root: './public' }));

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

type CityInfo = { id: number | null; name: string };

function parsePositiveInt(value: unknown): number | null {
    const raw = typeof value === 'string' ? value.trim() : value;
    if (raw === '' || raw === null || raw === undefined) return null;
    const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

function normalizeCityName(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.trim();
}

async function getCityById(cityId: number): Promise<CityInfo | null> {
    const [rows] = await pool.execute(
        'SELECT id, name FROM city WHERE id = ? LIMIT 1',
        [cityId]
    ) as any;
    if (!rows[0]) return null;
    return { id: rows[0].id, name: rows[0].name };
}

async function getCityByName(cityName: string): Promise<CityInfo | null> {
    const [rows] = await pool.execute(
        'SELECT id, name FROM city WHERE name = ? LIMIT 1',
        [cityName]
    ) as any;
    if (!rows[0]) return null;
    return { id: rows[0].id, name: rows[0].name };
}

async function getOrCreateCityByName(cityName: string): Promise<CityInfo | null> {
    await pool.execute(
        'INSERT IGNORE INTO city (name) VALUES (?)',
        [cityName]
    );
    return getCityByName(cityName);
}

async function resolveCityInfo(
    cityIdInput: unknown,
    cityNameInput: unknown,
    autoCreateByName = false
): Promise<CityInfo> {
    const cityId = parsePositiveInt(cityIdInput);
    if (cityId) {
        const cityById = await getCityById(cityId);
        if (cityById) return cityById;
        return { id: null, name: '' };
    }

    const cityName = normalizeCityName(cityNameInput);
    if (!cityName) return { id: null, name: '' };

    const cityByName = await getCityByName(cityName);
    if (cityByName) return cityByName;

    if (autoCreateByName) {
        const created = await getOrCreateCityByName(cityName);
        if (created) return created;
    }

    return { id: null, name: cityName };
}

async function resolveCityFilter(
    cityIdInput: string | undefined,
    cityInput: string | undefined
): Promise<{ hasFilter: boolean; cityId: number | null }> {
    const cityId = parsePositiveInt(cityIdInput);
    if (cityId) return { hasFilter: true, cityId };

    const cityName = normalizeCityName(cityInput);
    if (!cityName || cityName === 'all') return { hasFilter: false, cityId: null };

    const cityFromName = await getCityByName(cityName);
    if (cityFromName?.id) return { hasFilter: true, cityId: cityFromName.id };

    const cityIdFromCityQuery = parsePositiveInt(cityName);
    if (cityIdFromCityQuery) return { hasFilter: true, cityId: cityIdFromCityQuery };

    return { hasFilter: true, cityId: null };
}

async function resolveVenueCityInfo(venueIdInput: unknown): Promise<CityInfo> {
    const venueId = parsePositiveInt(venueIdInput);
    if (!venueId) return { id: null, name: '' };

    const [rows] = await pool.execute(
        `SELECT v.city_id, COALESCE(c.name, v.city, '') AS city_name
         FROM venue v
         LEFT JOIN city c ON v.city_id = c.id
         WHERE v.id = ? LIMIT 1`,
        [venueId]
    ) as any;

    if (!rows[0]) return { id: null, name: '' };
    return {
        id: parsePositiveInt(rows[0].city_id),
        name: rows[0].city_name || '',
    };
}

function resolveHallNameInput(payload: Record<string, any>): string {
    const hallName = typeof payload.hall_name === 'string' ? payload.hall_name.trim() : '';
    if (hallName) return hallName;
    const style = typeof payload.style === 'string' ? payload.style.trim() : '';
    return style;
}

function buildLeadMeta(payload: Record<string, any>): Record<string, any> {
    const keys = [
        'location',
        'activity',
        'productTool',
        'platform',
        'submitType',
        'channelId',
        'markId',
        'wid',
        'openId',
        'regionCode',
        'originPhone',
        'pagePath',
        'drawId',
        'dialogId',
        'formId',
        'countryCode',
        'mark',
    ];
    const meta: Record<string, any> = {};
    for (const key of keys) {
        const value = payload[key];
        if (value !== undefined && value !== null && value !== '') {
            meta[key] = value;
        }
    }
    return meta;
}

function toNullableJson(payload: Record<string, any>): string | null {
    return Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;
}

async function insertCaseImagesBulk(caseId: number | string, images: any[]): Promise<void> {
    const values = images
        .map((image, index) => {
            const url = typeof image === 'string'
                ? image
                : image?.image_url || image?.url || '';
            return [caseId, String(url).trim(), index];
        })
        .filter(([, url]) => !!url);

    if (values.length === 0) return;

    await pool.query(
        'INSERT INTO case_image (case_id, image_url, sort_order) VALUES ?',
        [values]
    );
}

// ============================================================
// 认证中间件
// ============================================================
const authMiddleware = adminAuthMiddleware;

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
            'SELECT id, username, password_hash, display_name, role FROM admin WHERE username = ? AND is_active = 1 LIMIT 1',
            [username]
        ) as any;
        if (rows.length === 0) {
            return c.json({ error: '用户名或密码错误' }, 401);
        }
        const admin = rows[0];
        const passwordCheck = await verifyAdminPassword(password, admin.password_hash);
        if (!passwordCheck.ok) {
            return c.json({ error: '用户名或密码错误' }, 401);
        }

        if (passwordCheck.needsUpgrade) {
            const nextHash = await hashAdminPassword(password);
            await pool.execute(
                'UPDATE admin SET password_hash = ? WHERE id = ?',
                [nextHash, admin.id]
            );
        }

        return c.json({
            code: 0,
            data: {
                token: issueAdminToken({
                    id: admin.id,
                    username: admin.username,
                    role: admin.role,
                    displayName: admin.display_name || '',
                }),
                admin: { id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role },
            },
        });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

app.use('/api/admin/*', async (c, next) => {
    if (c.req.path === '/api/admin/login') {
        await next();
        return;
    }
    await authMiddleware(c, next);
});

// ============================================================
// 微信小程序接口
// ============================================================

// 微信登录 - code 换取 session_key
app.post('/api/wx/login', async (c) => {
    try {
        const { code } = await c.req.json();
        if (!code) {
            return c.json({ error: 'code 不能为空' }, 400);
        }

        const { appId, appSecret } = getWechatConfig();

        const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;

        const res = await fetch(url);
        const data = await res.json() as any;

        if (data.errcode) {
            log.error({ data }, 'wechat login failed');
            return c.json({ error: data.errmsg || '微信登录失败' }, 400);
        }

        return c.json({
            code: 0,
            data: {
                session_key: data.session_key,
                openid: data.openid
            }
        });
    } catch (err: any) {
        log.error({ err }, 'wechat login exception');
        return c.json({ error: err.message }, 500);
    }
});

// 微信手机号解密
app.post('/api/wx/decrypt-phone', async (c) => {
    try {
        const { session_key, encryptedData, iv } = await c.req.json();

        if (!session_key || !encryptedData || !iv) {
            return c.json({ error: '参数不完整，需要 session_key, encryptedData, iv' }, 400);
        }

        // 使用 Node.js 内置 crypto 模块解密
        const crypto = await import('crypto');

        // Base64 解码
        const sessionKeyBuffer = Buffer.from(session_key, 'base64');
        const encryptedBuffer = Buffer.from(encryptedData, 'base64');
        const ivBuffer = Buffer.from(iv, 'base64');

        // AES-128-CBC 解密
        const decipher = crypto.createDecipheriv('aes-128-cbc', sessionKeyBuffer, ivBuffer);
        decipher.setAutoPadding(true);

        let decrypted = decipher.update(encryptedBuffer, undefined, 'utf8');
        decrypted += decipher.final('utf8');

        const phoneInfo = JSON.parse(decrypted);

        // 验证 appId
        const { appId } = getWechatConfig();
        if (phoneInfo.watermark?.appid !== appId) {
            log.warn({ actualAppId: phoneInfo.watermark?.appid, expectedAppId: appId }, 'wechat appId mismatch');
        }

        return c.json({
            code: 0,
            data: {
                phoneNumber: phoneInfo.phoneNumber,
                purePhoneNumber: phoneInfo.purePhoneNumber,
                countryCode: phoneInfo.countryCode
            }
        });
    } catch (err: any) {
        log.error({ err }, 'decrypt phone failed');
        return c.json({ error: '解密失败: ' + err.message }, 500);
    }
});

// 手机号授权留痕（公开，小程序调用 /api/lead/auth-phone）
app.post('/api/lead/auth-phone', async (c) => {
    try {
        const body = await c.req.json();
        const mobile = String(body.mobile || '').trim();
        if (!mobile) {
            return c.json({ error: '手机号不能为空' }, 400);
        }

        const knownKeys = [
            'mobile',
            'countryCode',
            'city',
            'source',
            'submitType',
            'channelId',
            'mark',
            'wid',
            'openId',
            'pagePath',
        ];
        const extraMeta: Record<string, any> = {};
        for (const [key, value] of Object.entries(body)) {
            if (!knownKeys.includes(key) && value !== undefined && value !== null && value !== '') {
                extraMeta[key] = value;
            }
        }

        await pool.execute(
            `INSERT INTO lead_auth_log (
                mobile, country_code, city, source, submit_type, channel_id, mark, page_path, wid, open_id, extra_meta
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                mobile,
                String(body.countryCode || '86').replace('+', ''),
                String(body.city || ''),
                String(body.source || ''),
                Number(body.submitType || 0),
                Number(body.channelId || 0),
                String(body.mark || 'mobile'),
                String(body.pagePath || ''),
                String(body.wid || ''),
                String(body.openId || ''),
                toNullableJson(extraMeta),
            ]
        );

        return c.json({ code: 0, data: { success: true } });
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
        invalidateCityCaches();
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
        invalidateCityCaches();
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
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.execute('UPDATE reservation SET city_id = NULL WHERE city_id = ?', [id]);
            await conn.execute('DELETE FROM city WHERE id = ?', [id]);
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            conn.release();
        }
        invalidateCityCaches();
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
        const cityFilter = await resolveCityFilter(
            c.req.query('cityId'),
            c.req.query('city')
        );
        if (cityFilter.hasFilter && !cityFilter.cityId) {
            return c.json(paginatedResponse([], 0, page, pageSize));
        }

        const conditions: string[] = [];
        const params: any[] = [];

        if (cityFilter.hasFilter && cityFilter.cityId) {
            conditions.push('v.city_id = ?');
            params.push(cityFilter.cityId);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const [countResult] = await pool.execute(
            `SELECT COUNT(*) as total FROM venue v ${whereClause}`,
            params
        ) as any;
        const total = countResult[0].total;

        const [rows] = await pool.execute(
            `SELECT
                v.id, v.name, v.city_id, COALESCE(c.name, v.city) AS city,
                v.address, v.phone, v.cover_url, v.business_hours, v.is_active,
                v.lat, v.lng, v.created_at
             FROM venue v
             LEFT JOIN city c ON v.city_id = c.id
             ${whereClause}
             ORDER BY v.id DESC LIMIT ? OFFSET ?`,
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
        const { name, city, city_id, address, phone, cover_url, business_hours, is_active, lat, lng } = body;
        if (!name) return c.json({ error: '门店名称不能为空' }, 400);

        const cityInfo = await resolveCityInfo(city_id, city, false);
        if ((city_id || city) && !cityInfo.id) {
            return c.json({ error: '城市不存在，请先在城市管理中创建' }, 400);
        }

        const [result] = await pool.execute(
            `INSERT INTO venue (name, city, city_id, address, phone, cover_url, business_hours, is_active, lat, lng)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name,
                cityInfo.name || '',
                cityInfo.id,
                address || '',
                phone || '',
                cover_url || '',
                business_hours || '',
                is_active ?? 1,
                lat || null,
                lng || null,
            ]
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
        const { name, city, city_id, address, phone, cover_url, business_hours, is_active, lat, lng } = body;
        const cityInfo = await resolveCityInfo(city_id, city, false);
        if ((city_id || city) && !cityInfo.id) {
            return c.json({ error: '城市不存在，请先在城市管理中创建' }, 400);
        }

        await pool.execute(
            `UPDATE venue SET name=?, city=?, city_id=?, address=?, phone=?, cover_url=?, business_hours=?, is_active=?, lat=?, lng=?
             WHERE id=?`,
            [
                name,
                cityInfo.name || '',
                cityInfo.id,
                address || '',
                phone || '',
                cover_url || '',
                business_hours || '',
                is_active ?? 1,
                lat || null,
                lng || null,
                c.req.param('id'),
            ]
        );
        return c.json({ code: 0 });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 删除门店
app.delete('/api/admin/venues/:id', authMiddleware, async (c) => {
    try {
        const id = c.req.param('id');
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.execute('DELETE FROM venue_image WHERE venue_id = ?', [id]);
            await conn.execute('UPDATE wedding_case SET venue_id = NULL WHERE venue_id = ?', [id]);
            await conn.execute('UPDATE reservation SET venue_id = NULL WHERE venue_id = ?', [id]);
            await conn.execute('DELETE FROM venue WHERE id = ?', [id]);
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            conn.release();
        }
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
        const { page, pageSize } = parsePagination(query);

        const cityFilter = await resolveCityFilter(query.cityId, query.city);
        if (cityFilter.hasFilter && !cityFilter.cityId) {
            return c.json(paginatedResponse([], 0, page, pageSize));
        }

        const result = await queryThemes({
            page,
            pageSize,
            cityId: cityFilter.cityId,
            venueId: query.venueId ? parseInt(query.venueId) : undefined,
            keyword: query.keyword,
            featured: query.featured !== undefined && query.featured !== '' ? parseInt(query.featured) : undefined,
            active: query.active !== undefined && query.active !== '' ? parseInt(query.active) : undefined,
            includeInactive: true,
            includeImages: true,
        });

        return c.json(paginatedResponse(
            result.list.map(toAdminTheme),
            result.total,
            result.page,
            result.pageSize
        ));
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 新增主题
app.post('/api/admin/themes', authMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const { title, tag, wedding_date, shop_label, description, cover_url, venue_id, sort_order, is_featured, is_active, images } = body;
        const hallName = resolveHallNameInput(body);
        if (!title) return c.json({ error: '主题名称不能为空' }, 400);

        const [result] = await pool.execute(
            `INSERT INTO wedding_case (title, tag, hall_name, style, wedding_date, shop_label, description, cover_url, venue_id, sort_order, is_featured, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [title, tag || '', hallName, hallName, wedding_date || '', shop_label || '', description || '', cover_url || '', venue_id || null, sort_order || 0, is_featured || 0, is_active ?? 1]
        ) as any;

        const caseId = result.insertId;

        // 批量插入图片
        if (images && Array.isArray(images) && images.length > 0) {
            await insertCaseImagesBulk(caseId, images);
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
        const { title, tag, wedding_date, shop_label, description, cover_url, venue_id, sort_order, is_featured, is_active, images } = body;
        const hallName = resolveHallNameInput(body);

        await pool.execute(
            `UPDATE wedding_case SET title=?, tag=?, hall_name=?, style=?, wedding_date=?, shop_label=?, description=?, cover_url=?, venue_id=?, sort_order=?, is_featured=?, is_active=?
             WHERE id=?`,
            [title, tag || '', hallName, hallName, wedding_date || '', shop_label || '', description || '', cover_url || '', venue_id || null, sort_order || 0, is_featured || 0, is_active ?? 1, id]
        );

        // 更新图片：先删后插
        if (images && Array.isArray(images)) {
            await pool.execute('DELETE FROM case_image WHERE case_id = ?', [id]);
            await insertCaseImagesBulk(id, images);
        }

        return c.json({ code: 0 });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 删除主题（应用层手动清理关联数据）
app.delete('/api/admin/themes/:id', authMiddleware, async (c) => {
    try {
        const id = c.req.param('id');
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.execute('DELETE FROM case_image WHERE case_id = ?', [id]);
            await conn.execute('UPDATE reservation SET case_id = NULL WHERE case_id = ?', [id]);
            await conn.execute('DELETE FROM wedding_case WHERE id = ?', [id]);
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            conn.release();
        }
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
 * 支持参数: page, pageSize, status, keyword, city/cityId
 */
app.get('/api/admin/reservations', authMiddleware, async (c) => {
    try {
        const query = c.req.query();
        const { page, pageSize, offset } = parsePagination(query);
        const status = query.status;
        const keyword = query.keyword;
        const city = query.city;
        const cityId = query.cityId;

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
        const cityFilter = await resolveCityFilter(cityId, city);
        if (cityFilter.hasFilter && !cityFilter.cityId) {
            return c.json(paginatedResponse([], 0, page, pageSize));
        }
        if (cityFilter.hasFilter && cityFilter.cityId) {
            conditions.push('r.city_id = ?');
            params.push(cityFilter.cityId);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const [countResult] = await pool.execute(
            `SELECT COUNT(*) as total FROM reservation r ${whereClause}`,
            params
        ) as any;
        const total = countResult[0].total;

        // 延迟关联：先在 idx_created 上定位 ID，再 JOIN 获取完整数据
        const [rows] = await pool.execute(
            `SELECT
                r.*,
                COALESCE(rc.name, r.city) AS city,
                v.name AS venue_name,
                wc.title AS case_title
             FROM reservation r
             INNER JOIN (
                 SELECT r2.id FROM reservation r2
                 ${whereClause.replace(/\br\./g, 'r2.')}
                 ORDER BY r2.created_at DESC
                 LIMIT ? OFFSET ?
             ) AS page_ids ON r.id = page_ids.id
             LEFT JOIN city rc ON r.city_id = rc.id
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
        const { name, mobile, wechat_openid, wedding_date, tables_count, venue_id, case_id, source, sub_platform, city, city_id } = body;
        if (!name || !mobile) return c.json({ error: '姓名和手机号不能为空' }, 400);

        const normalizedVenueId = parsePositiveInt(venue_id);
        let cityInfo = await resolveCityInfo(city_id, city, true);
        if (!cityInfo.id && normalizedVenueId) {
            cityInfo = await resolveVenueCityInfo(normalizedVenueId);
        }
        const leadMeta = buildLeadMeta(body);
        const wechatOpenId = wechat_openid || body.openId || body.openid || null;

        // reservation.mobile 具有唯一索引：同手机号的重复提交需要原子 upsert，避免并发插重复/抛重复键。
        // 业务语义：
        // - status/remark 属于运营跟进，不允许被二次提交覆盖
        // - submit_count 记录“该手机号提交次数”，每次重复提交 +1
        // - 其余字段尽量只用“非空新值”覆盖旧值
        const [result] = await pool.execute(
            `INSERT INTO reservation (
                name, mobile, wechat_openid, wedding_date, tables_count,
                venue_id, case_id, source, sub_platform, city, city_id, lead_meta
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                id = LAST_INSERT_ID(id),
                updated_at = CURRENT_TIMESTAMP,
                submit_count = COALESCE(submit_count, 1) + 1,
                name = VALUES(name),
                wechat_openid = COALESCE(VALUES(wechat_openid), wechat_openid),
                wedding_date = IF(VALUES(wedding_date) <> '', VALUES(wedding_date), wedding_date),
                tables_count = IF(VALUES(tables_count) <> 0, VALUES(tables_count), tables_count),
                venue_id = COALESCE(VALUES(venue_id), venue_id),
                case_id = COALESCE(VALUES(case_id), case_id),
                source = IF(VALUES(source) <> '', VALUES(source), source),
                sub_platform = IF(VALUES(sub_platform) <> '', VALUES(sub_platform), sub_platform),
                city = IF(VALUES(city) <> '', VALUES(city), city),
                city_id = COALESCE(VALUES(city_id), city_id),
                lead_meta = COALESCE(VALUES(lead_meta), lead_meta)`,
            [
                name,
                mobile,
                wechatOpenId,
                wedding_date || '',
                tables_count || 0,
                normalizedVenueId,
                case_id || null,
                source || '小程序',
                sub_platform || '',
                cityInfo.name || '',
                cityInfo.id,
                toNullableJson(leadMeta),
            ]
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
            `SELECT
                v.id, v.name, v.city_id,
                COALESCE(cv.name, v.city) AS city,
                v.address, v.cover_url
             FROM venue v
             LEFT JOIN city cv ON v.city_id = cv.id
             WHERE v.is_active = 1
             ORDER BY v.id
             LIMIT 6`
        ) as any;

        // 获取推荐案例
        const [cases] = await pool.execute(
            `SELECT
                wc.id, wc.title, wc.cover_url,
                COALESCE(NULLIF(wc.hall_name, ''), wc.style) AS hall_name,
                COALESCE(NULLIF(wc.hall_name, ''), wc.style) AS style,
                v.name AS venue_name,
                COALESCE(cv.name, v.city) AS city
             FROM wedding_case wc
             LEFT JOIN venue v ON wc.venue_id = v.id
             LEFT JOIN city cv ON v.city_id = cv.id
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
        const cityFilter = await resolveCityFilter(
            c.req.query('cityId'),
            c.req.query('city')
        );
        if (cityFilter.hasFilter && !cityFilter.cityId) {
            return c.json({ code: 0, data: [] });
        }

        const conditions: string[] = ['v.is_active = 1'];
        const params: any[] = [];

        if (cityFilter.hasFilter && cityFilter.cityId) {
            conditions.push('v.city_id = ?');
            params.push(cityFilter.cityId);
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;
        const [rows] = await pool.execute(
            `SELECT
                v.id, v.name, v.city_id, COALESCE(cv.name, v.city) AS city,
                v.address, v.phone, v.cover_url, v.business_hours, v.lat, v.lng
             FROM venue v
             LEFT JOIN city cv ON v.city_id = cv.id
             ${whereClause}
             ORDER BY v.city_id, v.id`,
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
            `SELECT wc.id, wc.title, wc.cover_url,
                    COALESCE(NULLIF(wc.hall_name, ''), wc.style) AS hall_name,
                    wc.tag,
                    v.name AS venue_name, COALESCE(cv.name, v.city) AS city,
                    (SELECT GROUP_CONCAT(ci.image_url ORDER BY ci.sort_order SEPARATOR ',')
                     FROM case_image ci WHERE ci.case_id = wc.id) AS imgs
             FROM wedding_case wc
             LEFT JOIN venue v ON wc.venue_id = v.id
             LEFT JOIN city cv ON v.city_id = cv.id
             WHERE wc.is_active = 1
             ORDER BY wc.is_featured DESC, wc.sort_order ASC, wc.id DESC
             LIMIT 50`
        ) as any;

        // 转换为小程序期望的格式
        const result = rows.map((row: any) => ({
            id: row.id,
            title: row.title,
            cover: row.cover_url,
            hall_name: row.hall_name,
            style: row.hall_name,
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
            `SELECT wc.*, v.name AS venue_name, COALESCE(cv.name, v.city) AS city
             FROM wedding_case wc
             LEFT JOIN venue v ON wc.venue_id = v.id
             LEFT JOIN city cv ON v.city_id = cv.id
             WHERE wc.id = ?`,
            [id]
        ) as any;

        if (rows.length === 0) {
            return c.json({ error: '案例不存在' }, 404);
        }

        const caseData = rows[0];
        caseData.hall_name = caseData.hall_name || caseData.style || '';
        caseData.style = caseData.hall_name;

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

// 获取主题列表（公开，小程序首页调用）
app.get('/api/themes', async (c) => {
    try {
        const cityFilter = await resolveCityFilter(
            c.req.query('cityId'),
            c.req.query('city')
        );

        const result = await queryThemes({
            page: 1,
            pageSize: 1000,
            cityId: cityFilter.cityId,
            includeInactive: false,
            includeImages: true,
        });

        return c.json({ code: 0, data: result.list.map(toPublicTheme) });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 获取单个主题详情（公开，小程序详情页调用）
app.get('/api/themes/:id', async (c) => {
    try {
        const id = c.req.param('id');
        const [rows] = await pool.execute(
            `SELECT wc.*,
                    COALESCE(NULLIF(wc.hall_name, ''), wc.style) AS hall_name,
                    v.name AS venue_name, COALESCE(cv.name, v.city) AS venue_city
             FROM wedding_case wc
             LEFT JOIN venue v ON wc.venue_id = v.id
             LEFT JOIN city cv ON v.city_id = cv.id
             WHERE wc.id = ? AND wc.is_active = 1`,
            [id]
        ) as any;

        if (rows.length === 0) {
            return c.json({ error: '主题不存在' }, 404);
        }

        const themeData = rows[0];

        // 获取图片列表
        const [images] = await pool.execute(
            `SELECT id, image_url, sort_order FROM case_image WHERE case_id = ? ORDER BY sort_order`,
            [id]
        ) as any;

        themeData.images = images;

        return c.json({ code: 0, data: toPublicThemeDetail(themeData) });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// 提交预约（公开，小程序调用 /api/booking）
app.post('/api/booking', async (c) => {
    try {
        const body = await c.req.json();
        const {
            name,
            mobile,
            city,
            city_id,
            source,
            subPlatform,
            sub_platform,
            venue_id,
            case_id,
            wedding_date,
            tables_count,
            wechat_openid,
            openId,
            openid,
        } = body;
        if (!name || !mobile) return c.json({ error: '姓名和手机号不能为空' }, 400);

        const normalizedVenueId = parsePositiveInt(venue_id);
        const normalizedWeddingDate = wedding_date || body.date || '';
        const normalizedTablesCount = tables_count ?? body.tables ?? 0;
        const normalizedSubPlatform = subPlatform || sub_platform || '';
        const wechatOpenId = wechat_openid || openId || openid || null;
        const leadMeta = buildLeadMeta(body);
        let cityInfo = await resolveCityInfo(city_id, city, true);
        if (!cityInfo.id && normalizedVenueId) {
            cityInfo = await resolveVenueCityInfo(normalizedVenueId);
        }

        const [result] = await pool.execute(
            `INSERT INTO reservation (
                name, mobile, wechat_openid, city, city_id, source, sub_platform,
                venue_id, case_id, wedding_date, tables_count, lead_meta
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                id = LAST_INSERT_ID(id),
                updated_at = CURRENT_TIMESTAMP,
                submit_count = COALESCE(submit_count, 1) + 1,
                name = VALUES(name),
                wechat_openid = COALESCE(VALUES(wechat_openid), wechat_openid),
                city = IF(VALUES(city) <> '', VALUES(city), city),
                city_id = COALESCE(VALUES(city_id), city_id),
                source = IF(VALUES(source) <> '', VALUES(source), source),
                sub_platform = IF(VALUES(sub_platform) <> '', VALUES(sub_platform), sub_platform),
                venue_id = COALESCE(VALUES(venue_id), venue_id),
                case_id = COALESCE(VALUES(case_id), case_id),
                wedding_date = IF(VALUES(wedding_date) <> '', VALUES(wedding_date), wedding_date),
                tables_count = IF(VALUES(tables_count) <> 0, VALUES(tables_count), tables_count),
                lead_meta = COALESCE(VALUES(lead_meta), lead_meta)`,
            [
                name,
                mobile,
                wechatOpenId,
                cityInfo.name || '',
                cityInfo.id,
                source || '小程序',
                normalizedSubPlatform,
                normalizedVenueId,
                case_id || null,
                normalizedWeddingDate,
                normalizedTablesCount,
                toNullableJson(leadMeta),
            ]
        ) as any;

        return c.json({ code: 0, data: { id: result.insertId } });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// ============================================================
// Weimob 1:1 Replica API 兼容层
// ============================================================

const weimobOk = (data: any = {}) => ({ errcode: 0, errmsg: 'success', data });

// 1. 授权留资 (savePhoneData) -> 写入 lead_auth_log
app.post('/api3/zhan/xapp/savePhoneData', async (c) => {
    try {
        const body = await c.req.json();
        const {
            formId, pageId, phone, submitType, markId, channelId, channel, mark, url,
            wid, uwid, openId, pid, zhanId, wxDecryptData
        } = body;
        
        await pool.execute(
            `INSERT INTO lead_auth_log (
                mobile, country_code, submit_type, channel_id, mark, page_path, 
                wid, open_id, pid, zhan_id, form_id, page_id, mark_id, url, channel, wx_decrypt_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                phone || '', '86',
                Number(submitType || 0), Number(channelId || 0), mark || 'mobile', pageId || '',
                wid || '', openId || '', pid || '', zhanId || '', formId || '', pageId || '',
                markId || '', url || '', channel || '',
                wxDecryptData ? JSON.stringify(wxDecryptData) : null
            ]
        );
        return c.json(weimobOk());
    } catch (err: any) {
        log.error({ err }, 'savePhoneData error');
        return c.json({ errcode: 500, errmsg: err.message, data: {} });
    }
});

// 2. 提交线索 (submit) -> 写入 lead_submit & lead_submit_field
app.post('/api3/zhan/xapp/submit', async (c) => {
    try {
        const body = await c.req.json();
        const {
            formId, pageId, phone, regionCode, originPhone, submitType, markId, channelId,
            drawId, dialogId, wid, uwid, openId, submitButtonId, url, data, pid, zhanId
        } = body;

        // 1. 存主表
        const [submitResult] = await pool.execute(
            `INSERT INTO lead_submit (
                pid, zhan_id, wid, uwid, open_id, form_id, page_id, submit_type, channel_id, 
                mark_id, draw_id, dialog_id, submit_button_id, url, phone, region_code, 
                origin_phone, raw_payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                pid || '', zhanId || '', wid || '', uwid || '', openId || '', formId || '', pageId || '',
                Number(submitType || 0), Number(channelId || 0), markId || '', drawId || '', dialogId || '', 
                submitButtonId || '', url || '', phone || '', regionCode || '', originPhone || '',
                JSON.stringify(body)
            ]
        ) as any;

        const submitId = submitResult.insertId;

        // 2. 存子表 (遍历 data 数组)
        if (Array.isArray(data) && data.length > 0) {
            for (let i = 0; i < data.length; i++) {
                const item = data[i];
                // 防御性保护，提取 item 属性
                const fieldKey = item.fieldKey || item.name || '';
                const label = item.label || '';
                const itemMark = item.mark || '';
                const mode = String(item.mode || '');
                const valueJson = item.value !== undefined ? JSON.stringify(item.value) : null;
                const showValue = item.showValue || (typeof item.value === 'string' ? item.value : '');

                await pool.execute(
                    `INSERT INTO lead_submit_field (
                        submit_id, field_key, label, mark, mode, value_json, show_value, sort_order
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [submitId, fieldKey, label, itemMark, mode, valueJson, showValue, i]
                );
            }
        }

        return c.json(weimobOk());
    } catch (err: any) {
        log.error({ err }, 'submit error');
        return c.json({ errcode: 500, errmsg: err.message, data: {} });
    }
});

// 3. 线索列表 (form/list) -> 从 lead_submit 查询并还原 data[]
app.post('/api3/zhan/xapp/form/list', async (c) => {
    try {
        const body = await c.req.json();
        const wid = body.wid || '';
        const pageNum = Math.max(1, body.pageNum || 1);
        const pageSize = Math.min(50, Math.max(1, body.pageSize || 10));
        const offset = (pageNum - 1) * pageSize;

        // 先查总数
        const [countRes] = await pool.execute(
            'SELECT COUNT(*) as total FROM lead_submit WHERE wid = ?',
            [wid]
        ) as any;
        const total = countRes[0].total;

        // 再查主记录
        const [rows] = await pool.execute(
            'SELECT id, form_id, page_id, created_at FROM lead_submit WHERE wid = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [wid, pageSize, offset]
        ) as any;

        const submitIds = rows.map((row: any) => row.id);
        const fieldsBySubmitId = new Map<number, any[]>();
        if (submitIds.length > 0) {
            const placeholders = submitIds.map(() => '?').join(',');
            const [fieldRows] = await pool.query(
                `SELECT submit_id, field_key, label, mark, mode, value_json, show_value
                 FROM lead_submit_field
                 WHERE submit_id IN (${placeholders})
                 ORDER BY submit_id ASC, sort_order ASC`,
                submitIds
            ) as any;

            for (const field of fieldRows) {
                const group = fieldsBySubmitId.get(field.submit_id) || [];
                group.push(field);
                fieldsBySubmitId.set(field.submit_id, group);
            }
        }

        const list = [];
        for (const row of rows) {
            const fields = fieldsBySubmitId.get(row.id) || [];

            const dataArray = fields.map((f: any) => ({
                fieldKey: f.field_key,
                label: f.label,
                mark: f.mark,
                mode: f.mode,
                value: f.value_json ? JSON.parse(f.value_json) : null,
                showValue: f.show_value
            }));

            // 按照原系统所需的返回结构（只含关键的展示用壳子）
            list.push({
                submitId: row.id,
                formId: row.form_id,
                pageId: row.page_id,
                submitTime: new Date(row.created_at).getTime(),
                data: dataArray
            });
        }

        return c.json(weimobOk({
            list,
            total,
            pageNum,
            pageSize
        }));
    } catch (err: any) {
        log.error({ err }, 'form list error');
        return c.json({ errcode: 500, errmsg: err.message, data: {} });
    }
});

// 4. 线索详情 (form/detail)
app.post('/api3/zhan/xapp/form/detail', async (c) => {
    try {
        const body = await c.req.json();
        const submitId = body.submitId;

        const [rows] = await pool.execute(
            'SELECT id, form_id, page_id, created_at FROM lead_submit WHERE id = ?',
            [submitId]
        ) as any;

        if (rows.length === 0) {
            return c.json({ errcode: 1044, errmsg: 'not found', data: {} });
        }

        const row = rows[0];

        const [fields] = await pool.execute(
            'SELECT field_key, label, mark, mode, value_json, show_value FROM lead_submit_field WHERE submit_id = ? ORDER BY sort_order ASC',
            [row.id]
        ) as any;

        const dataArray = fields.map((f: any) => ({
            fieldKey: f.field_key,
            label: f.label,
            mark: f.mark,
            mode: f.mode,
            value: f.value_json ? JSON.parse(f.value_json) : null,
            showValue: f.show_value
        }));

        return c.json(weimobOk({
            submitId: row.id,
            formId: row.form_id,
            pageId: row.page_id,
            submitTime: new Date(row.created_at).getTime(),
            data: dataArray
        }));
    } catch (err: any) {
        log.error({ err }, 'form detail error');
        return c.json({ errcode: 500, errmsg: err.message, data: {} });
    }
});

// ============================================================
// 文件上传（ali-oss）
// ============================================================
app.post('/api/upload', authMiddleware, async (c) => {
    try {
        const maxUploadSizeBytes = Number.parseInt(process.env.UPLOAD_MAX_SIZE_BYTES || '', 10) || 10 * 1024 * 1024;
        const traceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const userAgent = c.req.header('user-agent') || '';
        const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '';
        const body = await c.req.parseBody();
        const file = body['file'];
        log.info({ traceId, ip, userAgent, fields: Object.keys(body) }, 'upload request received');
        if (!file || typeof file === 'string' || typeof (file as any).arrayBuffer !== 'function') {
            log.warn({ traceId }, 'upload missing file field or invalid payload');
            return c.json({ error: '请选择文件' }, 400);
        }
        log.info({ traceId, fileName: file.name, mimeType: file.type || 'unknown', size: file.size }, 'upload file metadata');
        if (file.size <= 0) {
            log.warn({ traceId, fileName: file.name }, 'upload file size is zero');
            return c.json({ error: '上传文件为空（0B），请重新选择图片' }, 400);
        }
        if (file.size > maxUploadSizeBytes) {
            log.warn({ traceId, size: file.size, limit: maxUploadSizeBytes }, 'upload file too large');
            return c.json({ error: `文件大小不能超过 ${Math.floor(maxUploadSizeBytes / 1024 / 1024)}MB` }, 400);
        }

        const ext = path.extname(file.name) || '.jpg';
        const fileName = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        const buffer = Buffer.from(await file.arrayBuffer());
        log.info({ traceId, bufferLength: buffer.length }, 'upload buffer ready');
        if (buffer.length <= 0) {
            log.warn({ traceId, fileName: file.name }, 'upload buffer length is zero');
            return c.json({ error: '读取上传文件失败（0B），请重试' }, 400);
        }

        const result = await ossClient.put(fileName, buffer, {
            headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'Content-Disposition': 'inline',
            },
        });
        if (!result?.url) {
            log.error({ traceId, objectName: fileName }, 'upload succeeded but oss url missing');
            return c.json({ error: '上传成功但未获取到文件地址' }, 500);
        }
        const secureUrl = result.url.replace('http://', 'https://');
        log.info({ traceId, objectName: fileName, url: secureUrl }, 'upload completed');

        return c.json({ code: 0, data: { url: secureUrl } });
    } catch (err: any) {
        log.error({ err }, 'upload unexpected error');
        return c.json({ error: err.message }, 500);
    }
});

// ============================================================
// 0305 扩展路由挂载
// ============================================================
app.route('/api/mp', mpRoutes);          // 小程序端接口
app.route('/mp', mpRoutes);              // 小程序端接口 (兼容前端直接调用 /mp/*)
app.route('/api/admin', admin305Routes); // CMS管理端扩展接口（需认证，复用 authMiddleware）
app.route('/api3', api3Routes);          // 0305 1:1 模拟接口

// ============================================================
// 启动
// ============================================================
const PORT = parseInt(process.env.PORT || '8199');

async function boot() {
    if (process.env.RUN_DB_INIT || process.env.RUN_DB_MIGRATIONS) {
        log.warn(
            {
                RUN_DB_INIT: process.env.RUN_DB_INIT || null,
                RUN_DB_MIGRATIONS: process.env.RUN_DB_MIGRATIONS || null,
            },
            'database init and migration flags are ignored at runtime; use scripts instead'
        );
    }

    startMessageTaskWorker();

    serve({
        fetch: app.fetch,
        port: PORT,
        hostname: '0.0.0.0',
    }, (info) => {
        log.info({ host: '0.0.0.0', port: info.port }, 'server started');
    });
}

boot().catch((err) => {
    log.error({ err }, 'boot failed');
    process.exit(1);
});
