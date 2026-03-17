/**
 * 0305 小程序端 API 路由
 * 
 * 接口前缀: /api/mp/
 * JSON 响应格式保持与原版 0305 一致: { errcode, errmsg, data }
 */
import { Hono } from 'hono';
import pool from '../db.js';
import { sendFormSubmitNotification, sendNewLeadNotificationToAdmins } from '../services/wechat.service.js';
import { notifySalesNewLead } from '../services/sms.service.js';
import { remember } from '../response-cache.js';

const mp = new Hono();

// 统一响应格式 (兼容原版 0305)
const ok = (data: any = {}) => ({ errcode: 0, errmsg: 'success', data });
const fail = (msg: string, code = 500) => ({ errcode: code, errmsg: msg, data: {} });

// ============================================================
// categoryKey → categoryId 解析映射器
// 前端发送 categoryKey (如 'birthday_case', 'business_package')
// 后端需要将其转换为正确的 category_id
// ============================================================
const CATEGORY_KEY_MAP: Record<string, { table: string; slug?: string; name?: string }> = {
  // 案例分类 (case_category)
  birthday_case:  { table: 'case_category', name: '生日宴' },
  business_case:  { table: 'case_category', name: '商务' },
  wedding_case:   { table: 'case_category', name: '婚礼案例' },
  // 套餐分类 (package_category)
  birthday_package: { table: 'package_category', slug: 'birthday' },
  kids_package:     { table: 'package_category', slug: 'kids' },
  business_package: { table: 'package_category', slug: 'business' },
  wedding_menu:     { table: 'package_category', slug: 'wedding_menu' },
  wedding_pkg:      { table: 'package_category', slug: 'wedding_pkg' },
};

const CATEGORY_ID_CACHE_TTL_MS = 10 * 60 * 1000;
const categoryIdCache = new Map<string, { id: number | null; expiresAt: number }>();

async function resolveCategoryId(categoryKey: string): Promise<number | null> {
  const cached = categoryIdCache.get(categoryKey);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  const mapping = CATEGORY_KEY_MAP[categoryKey];
  if (!mapping) {
    categoryIdCache.set(categoryKey, { id: null, expiresAt: Date.now() + CATEGORY_ID_CACHE_TTL_MS });
    return null;
  }
  
  let query = '';
  let param = '';
  if (mapping.slug) {
    query = `SELECT id FROM ${mapping.table} WHERE slug = ? AND is_active = 1 LIMIT 1`;
    param = mapping.slug;
  } else if (mapping.name) {
    query = `SELECT id FROM ${mapping.table} WHERE name LIKE ? AND is_active = 1 LIMIT 1`;
    param = `%${mapping.name}%`;
  } else {
    categoryIdCache.set(categoryKey, { id: null, expiresAt: Date.now() + CATEGORY_ID_CACHE_TTL_MS });
    return null;
  }
  
  const [rows] = await pool.execute(query, [param]) as any;
  const id = rows.length > 0 ? rows[0].id : null;
  categoryIdCache.set(categoryKey, { id, expiresAt: Date.now() + CATEGORY_ID_CACHE_TTL_MS });
  return id;
}

// ============================================================
// 页面配置 (对应原版 POST /api3/zhan/xapp/page)
// ============================================================
mp.post('/page', async (c) => {
    try {
        const { pageKey, hash } = await c.req.json();
        const key = pageKey || hash || 'home';

        const row = await remember(`page:v1:${key}`, 60_000, async () => {
            const [rows] = await pool.execute(
                'SELECT page_key, title, bg_color, elements_json, bottom_nav_json, music_url FROM page_config WHERE page_key = ? AND is_active = 1',
                [key]
            ) as any;
            return rows[0] || null;
        });

        if (!row) {
            return c.json(ok({
                hash: key, pageId: key, title: '', backgroundColor: '#ffffff',
                elements: [], bottomNav: { show: false, data: {} }
            }));
        }

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
        const categories = await remember('categories:v1', 5 * 60_000, async () => {
            const [rows] = await pool.execute(
                `SELECT
                    cc.id,
                    cc.name,
                    COALESCE(cnt.total, 0) AS count
                 FROM case_category cc
                 LEFT JOIN (
                    SELECT category_id, COUNT(*) AS total
                    FROM wedding_case
                    WHERE is_active = 1 AND category_id IS NOT NULL
                    GROUP BY category_id
                 ) cnt ON cnt.category_id = cc.id
                 WHERE cc.is_active = 1
                 ORDER BY cc.sort_order, cc.id`
            ) as any;
            return rows;
        });

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
        const { categoryId, categoryKey, pageNum = 1, pageSize = 10 } = await c.req.json();
        const offset = (Math.max(1, pageNum) - 1) * Math.min(50, pageSize);

        const conditions: string[] = ['wc.is_active = 1'];
        const params: any[] = [];

        // 支持 categoryKey (如 'birthday_case') 自动解析为 categoryId
        let resolvedCategoryId = categoryId;
        if (!resolvedCategoryId && categoryKey) {
            resolvedCategoryId = await resolveCategoryId(categoryKey);
        }

        if (resolvedCategoryId) {
            conditions.push('wc.category_id = ?');
            params.push(resolvedCategoryId);
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
        const categories = await remember('package_categories:v1', 5 * 60_000, async () => {
            const [rows] = await pool.execute(
                `SELECT id, name, slug, cover_url AS coverUrl
                 FROM package_category
                 WHERE is_active = 1
                 ORDER BY sort_order, id`
            ) as any;
            return rows;
        });
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
        const { categoryId, categoryKey, slug, pageNum = 1, pageSize = 20 } = await c.req.json();
        const offset = (Math.max(1, pageNum) - 1) * Math.min(50, pageSize);

        const conditions: string[] = ['p.is_active = 1'];
        const params: any[] = [];

        // 支持 categoryKey (如 'business_package') 自动解析为 categoryId
        let resolvedCategoryId = categoryId;
        if (!resolvedCategoryId && categoryKey) {
            resolvedCategoryId = await resolveCategoryId(categoryKey);
        }

        if (resolvedCategoryId) {
            conditions.push('p.category_id = ?');
            params.push(resolvedCategoryId);
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

        const list = await remember(`venues:v1:${cityId || ''}:${brandId || ''}`, 60_000, async () => {
            const [rows] = await pool.execute(
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

            // 批量查询所有门店的轮播图（避免 N+1）
            const venueIds = rows.map((v: any) => v.id);
            if (venueIds.length > 0) {
                const placeholders = venueIds.map(() => '?').join(',');
                const [allImgs] = await pool.execute(
                    `SELECT venue_id, image_url FROM venue_image WHERE venue_id IN (${placeholders}) ORDER BY sort_order`,
                    venueIds
                ) as any;
                const imgMap = new Map<number, string[]>();
                for (const img of allImgs) {
                    if (!imgMap.has(img.venue_id)) imgMap.set(img.venue_id, []);
                    imgMap.get(img.venue_id)!.push(img.image_url);
                }
                for (const venue of rows) {
                    venue.images = imgMap.get(venue.id) || [];
                }
            }

            return rows;
        });

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

        // 批量查询封面图（避免 N+1）：没有 coverUrl 的厅用 case_image 第一张兜底
        const hallsNeedCover = list.filter((h: any) => !h.coverUrl);
        if (hallsNeedCover.length > 0) {
            const hallIds = hallsNeedCover.map((h: any) => h.id);
            const placeholders = hallIds.map(() => '?').join(',');
            const [coverImgs] = await pool.execute(
                `SELECT case_id, image_url FROM case_image 
                 WHERE case_id IN (${placeholders}) 
                 ORDER BY sort_order`,
                hallIds
            ) as any;
            // 取每个 case_id 的第一张图
            const coverMap = new Map<number, string>();
            for (const img of coverImgs) {
                if (!coverMap.has(img.case_id)) {
                    coverMap.set(img.case_id, img.image_url);
                }
            }
            for (const hall of hallsNeedCover) {
                hall.coverUrl = coverMap.get(hall.id) || '';
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
        const brand = await remember('brand:v1', 5 * 60_000, async () => {
            const [rows] = await pool.execute(
                'SELECT id, name, logo_url AS logoUrl, slogan, description, contact_phone AS contactPhone, contact_wechat AS contactWechat FROM brand WHERE is_active = 1 LIMIT 1'
            ) as any;
            return rows[0] || null;
        });

        return c.json(ok(brand || {}));
    } catch (err: any) {
        return c.json(fail(err.message));
    }
});

// ============================================================
// 城市列表
// ============================================================
mp.post('/cities', async (c) => {
    try {
        const list = await remember('cities:v1', 5 * 60_000, async () => {
            const [rows] = await pool.execute(
                'SELECT id, name FROM city WHERE is_active = 1 ORDER BY sort_order, id'
            ) as any;
            return rows;
        });
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

        const nameField = Array.isArray(fields) ? fields.find((f: any) => f.fieldKey === 'name' || f.mark === 'name') : null;
        const phoneField = Array.isArray(fields) ? fields.find((f: any) => f.fieldKey === 'phone' || f.mark === 'phone') : null;
        const dateField = Array.isArray(fields) ? fields.find((f: any) => f.fieldKey === 'weddingDate' || f.mark === 'weddingDate') : null;
        const storeField = Array.isArray(fields) ? fields.find((f: any) => f.fieldKey === 'store' || f.mark === 'store') : null;
        const nameVal = nameField?.showValue || nameField?.value || '';
        const phoneVal = phoneField?.showValue || phoneField?.value || phone || '';
        const dateVal = dateField?.showValue || dateField?.value || '';
        const openId = body.openId || '';
        const conn = await pool.getConnection();
        let submitId = 0;

        try {
            await conn.beginTransaction();

            // 1. 写入 lead_submit 主表
            const [submitResult] = await conn.execute(
                `INSERT INTO lead_submit (
                    pid, zhan_id, wid, uwid, open_id, form_id, page_id,
                    submit_type, channel_id, phone, raw_payload
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    body.pid || '', body.zhanId || '', body.wid || '', body.uwid || '',
                    openId || '', formId || '', pageId || '',
                    Number(body.submitType || 0), Number(body.channelId || 0),
                    phoneVal || '',
                    JSON.stringify(body)
                ]
            ) as any;

            submitId = submitResult.insertId;

            // 2. 写入 lead_submit_field 子表（批量）
            if (Array.isArray(fields) && fields.length > 0) {
                const values = fields.map((item: any, index: number) => [
                    submitId,
                    item.fieldKey || item.name || '',
                    item.label || '',
                    item.mark || '',
                    String(item.mode || ''),
                    item.value !== undefined ? JSON.stringify(item.value) : null,
                    item.showValue || (typeof item.value === 'string' ? item.value : ''),
                    index,
                ]);

                await conn.query(
                    `INSERT INTO lead_submit_field (submit_id, field_key, label, mark, mode, value_json, show_value, sort_order)
                     VALUES ?`,
                    [values]
                );
            }

            // 3. CRM 聚合表按手机号原子 upsert，配合唯一索引避免并发首次提交重复插入
            if (nameVal && phoneVal) {
                const leadMeta = JSON.stringify({ formId, pageId, submitId });
                await conn.execute(
                    `INSERT INTO reservation (name, mobile, wedding_date, source, lead_meta, submit_count)
                     VALUES (?, ?, ?, ?, ?, 1)
                     ON DUPLICATE KEY UPDATE
                        lead_meta = VALUES(lead_meta),
                        submit_count = COALESCE(submit_count, 1) + 1,
                        updated_at = NOW()`,
                    [nameVal, phoneVal, dateVal, '小程序-0305', leadMeta]
                );
            }

            await conn.commit();
        } catch (e) {
            try { await conn.rollback(); } catch (_) {}
            throw e;
        } finally {
            conn.release();
        }

        // 4. 发送订阅消息通知
        if (openId && nameVal && phoneVal) {
            try {
                await sendFormSubmitNotification(openId, {
                    name: nameVal,
                    phone: phoneVal,
                    store: storeField?.showValue || storeField?.value || '',
                    weddingDate: dateVal
                });
            } catch (notifyErr: any) {
                // 通知失败不影响主流程，仅记录日志
                console.error('[Submit] 发送订阅消息失败:', notifyErr.message);
            }
        }

        // 5. 发送新留资通知给管理员
        try {
            await sendNewLeadNotificationToAdmins({
                name: nameVal,
                phone: phoneVal,
                store: storeField?.showValue || storeField?.value || '',
                weddingDate: dateVal
            });
        } catch (adminNotifyErr: any) {
            console.error('[Submit] 发送管理员通知失败:', adminNotifyErr.message);
        }

        // 6. 发送短信通知给销售
        try {
            await notifySalesNewLead({
                name: nameVal,
                phone: phoneVal,
                store: storeField?.showValue || storeField?.value || '',
                weddingDate: dateVal
            });
        } catch (smsErr: any) {
            console.error('[Submit] 发送短信通知失败:', smsErr.message);
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

// ============================================================
// 订阅消息授权记录
// ============================================================
mp.post('/subscribe/report', async (c) => {
    try {
        const { templateIds, bizType, openId } = await c.req.json();

        if (!templateIds || !Array.isArray(templateIds) || templateIds.length === 0) {
            return c.json(fail('模板ID不能为空'));
        }

        if (!openId) {
            return c.json(fail('OpenID不能为空'));
        }

        // 批量插入订阅记录
        const values = templateIds.map(templateId => [
            openId,
            templateId,
            bizType || 'general',
            new Date()
        ]);

        await pool.query(
            `INSERT INTO user_subscribe (open_id, template_id, biz_type, created_at)
             VALUES ?
             ON DUPLICATE KEY UPDATE
                biz_type = VALUES(biz_type),
                updated_at = NOW()`,
            [values]
        );

        console.log('[Subscribe] 记录用户订阅:', { openId, templateIds, bizType });
        return c.json(ok({ message: '订阅记录成功' }));
    } catch (err: any) {
        console.error('[Subscribe] 记录订阅失败:', err);
        return c.json(fail(err.message));
    }
});

export default mp;
