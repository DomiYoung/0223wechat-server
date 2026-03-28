import { Hono } from 'hono';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db.js';
import { appLogger } from '../logger.js';
import { remember } from '../response-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const api3 = new Hono();
const log = appLogger.child({ module: 'api3-routes' });

// 数据目录
const DATA_DIR = path.join(__dirname, '../api_dump');
const apiDumpCache = new Map<string, any>();
let dataDirFilesPromise: Promise<string[]> | null = null;

// 统一成功响应包装
const ok = (data: any = {}) => ({
    errcode: 0,
    errmsg: 'success',
    data
});

// 品牌映射配置
const BRAND_MAPPINGS = [
    { old: /圣\s*拉\s*维/g, new: '嘉美麓德' },
    { old: /莉\s*维\s*娜/g, new: '嘉美麓德' },
    { old: /海\s*岛\s*店/g, new: '旗舰店' },
    { old: /滨\s*江\s*店/g, new: '漕河泾臻选店' },
    { old: /汇\s*景\s*宴\s*会\s*中\s*心/g, new: '阿拉宫' },
    { old: /Saint\s*Lavie/gi, new: 'Jiamei Lude' }
];

function applyBranding(content: string): string {
    let result = content;
    for (const mapping of BRAND_MAPPINGS) {
        result = result.replace(mapping.old, mapping.new);
    }
    return result;
}

async function getDataDirFiles() {
    if (!dataDirFilesPromise) {
        dataDirFilesPromise = fsPromises.readdir(DATA_DIR);
    }
    return dataDirFilesPromise;
}

async function readApiDumpJson(fileName: string) {
    if (apiDumpCache.has(fileName)) {
        return apiDumpCache.get(fileName);
    }

    const filePath = path.join(DATA_DIR, fileName);
    const raw = await fsPromises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(applyBranding(raw));
    apiDumpCache.set(fileName, parsed);
    return parsed;
}

// ========================
// 1. 获取页面配置 (Core)
// ========================
api3.post('/zhan/xapp/page', async (c) => {
    try {
        const body = await c.req.json().catch(() => ({}));
        const { pageId, hash } = body;
        log.info({ pageId, hash }, 'api3 page requested');

        // 定位文件
        let fileName = '';
        const files = await getDataDirFiles();
        if (pageId) {
            fileName = files.find(f => f.includes(`page_`) && f.includes(`_${pageId}.json`)) || '';
        }
        
        if (!fileName && hash) {
            fileName = files.find(f => f.includes(`sub_`) && f.includes(`_${hash}.json`)) || '';
        }

        if (fileName) {
            return c.json(await readApiDumpJson(fileName));
        }

        // 回退首页
        log.warn({ pageId, hash }, 'api3 page not found, falling back to home');
        if (fs.existsSync(path.join(DATA_DIR, 'page_home_3692202.json'))) {
            return c.json(await readApiDumpJson('page_home_3692202.json'));
        }

        return c.json(ok({ msg: 'no data' }), 404);
    } catch (err: any) {
        log.error({ err }, 'api3 page request failed');
        return c.json({ errcode: 500, errmsg: err.message }, 500);
    }
});

// ========================
// 2. 登录与身份验证 (Auth)
// ========================
const getMockLoginResponse = async () => {
    try {
        const brand = await remember('api3:brand:min', 5 * 60_000, async () => {
            const [rows] = await pool.execute('SELECT name, logo_url FROM brand WHERE is_active = 1 LIMIT 1') as any;
            return rows[0] || { name: '嘉美麓德', logo_url: '' };
        });
        
        return {
            wid: 10838588381,
            bwid: 4022029389381,
            token: 'mock_token_0305_' + Date.now(),
            scope: 'snsapi_userinfo',
            nickname: brand.name,
            logo: brand.logo_url || 'https://creativepro.oss-cn-shanghai.aliyuncs.com/0305/images/home_logo-1773508463353.png',
            headurl: brand.logo_url || 'https://creativepro.oss-cn-shanghai.aliyuncs.com/0305/images/home_logo-1773508463353.png'
        };
    } catch (e) {
        return {
            wid: 10838588381,
            bwid: 4022029389381,
            token: 'mock_token_0305_error',
            nickname: '嘉美麓德'
        };
    }
};

api3.post('/api2/user/login', async (c) => c.json(ok(await getMockLoginResponse())));
api3.post('/fe/mapi/user/login', async (c) => c.json(ok(await getMockLoginResponse())));
api3.post('/fe/mapi/user/loginUserInfo', async (c) => c.json(ok(await getMockLoginResponse())));
api3.post('/fe/mapi/user/userProfile', async (c) => c.json(ok(await getMockLoginResponse())));
api3.post('/api/mp/user/profile', async (c) => c.json(ok(await getMockLoginResponse())));
api3.post('/login', async (c) => c.json(ok(await getMockLoginResponse())));

// ========================
// 3. 协议与合规相关
// ========================
api3.post('/zhan/xapp/agreement/detail', async (c) => {
    try {
        const brand = await remember('api3:brand:min', 5 * 60_000, async () => {
            const [rows] = await pool.execute('SELECT name, logo_url FROM brand WHERE is_active = 1 LIMIT 1') as any;
            return rows[0] || { name: '嘉美麓德', logo_url: '' };
        });
        
        return c.json(ok({
            status: 0,
            wid: 10838588381,
            merchantName: brand.name,
            logo: brand.logo_url || 'https://creativepro.oss-cn-shanghai.aliyuncs.com/0305/images/home_logo-1773508463353.png'
        }));
    } catch (e) {
        return c.json(ok({ merchantName: '嘉美麓德' }));
    }
});

api3.post('/zhan/xapp/useragreement/check', (c) => c.json(ok({ agree: true, times: 0 })));
api3.post('/zhan/xapp/useragreement/openorclose', (c) => c.json(ok({ open: false })));
api3.post('/zhan/xapp/useragreement/list', (c) => c.json(ok([])));

// ========================
// 4. CMS 文章列表与分类 (改为数据库驱动)
// ========================
api3.post('/zhan/xapp/getContentPageClassifyData', async (c) => {
    try {
        const classifyList = await remember('api3:classify:list', 5 * 60_000, async () => {
            const [caseCats] = await pool.execute('SELECT id, name FROM case_category WHERE is_active = 1 ORDER BY sort_order ASC') as any;
            const [pkgCats] = await pool.execute('SELECT id, name FROM package_category WHERE is_active = 1 ORDER BY sort_order ASC') as any;
            return [
                ...caseCats.map((cc: any) => ({ id: cc.id, name: cc.name, type: 1 })),
                ...pkgCats.map((pc: any) => ({ id: pc.id, name: pc.name, type: 2 }))
            ];
        });

        return c.json(ok({
            classifyList,
            total: classifyList.length
        }));
    } catch (e) {
        log.error({ err: e }, 'api3 classify query failed');
        if (fs.existsSync(path.join(DATA_DIR, 'cms_classify.json'))) {
            const data = await readApiDumpJson('cms_classify.json');
            if (data.errcode === 0) return c.json(data);
        }
        return c.json(ok({ classifyList: [], total: 0 }));
    }
});

api3.post('/zhan/xapp/getContentData', async (c) => {
    try {
        const [rows] = await pool.execute(`
            SELECT id, title as name, cover_url as cover, description 
            FROM wedding_case 
            WHERE is_active = 1 
            ORDER BY sort_order ASC, id DESC
            LIMIT 20
        `) as any;

        const list = rows.map((r: any) => ({
            id: r.id,
            title: r.name,
            coverImgUrl: r.cover,
            description: r.description,
            pageId: r.id,
            createTime: new Date().toISOString()
        }));

        return c.json(ok({
            list,
            total: list.length,
            pageNum: 1,
            pageSize: 20
        }));
    } catch (e) {
        log.error({ err: e }, 'api3 content query failed');
        if (fs.existsSync(path.join(DATA_DIR, 'cms_list.json'))) {
            const data = await readApiDumpJson('cms_list.json');
            if (data.errcode === 0) return c.json(data);
        }
        return c.json(ok({ list: [], total: 0 }));
    }
});

api3.post('/zhan/xapp/getPageData', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    log.info({ body }, 'api3 cms detail requested');
    return c.json(ok({})); 
});

// ========================
// 5. 表单提交 (Core Lead Submission)
// ========================
api3.post('/zhan/xapp/submit', async (c) => {
    try {
        const body = await c.req.json().catch(() => ({}));
        const { phone, submitType, data } = body;

        log.info({ phone, submitType, fieldCount: data?.length }, 'api3 submit lead');

        // === 校验 ===
        if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
            return c.json({ errcode: 400, errmsg: '请输入正确的手机号' }, 400);
        }
        if (!data || !Array.isArray(data) || data.length === 0) {
            return c.json({ errcode: 400, errmsg: '提交数据为空' }, 400);
        }

        // === 3. 从 data[] 中提取结构化字段 ===
        const fieldMap = new Map(data.map((f: any) => [f.fieldKey || f.mark, f.value || f.showValue || '']));
        const name = (fieldMap.get('name') || '') as string;
        const salutation = (fieldMap.get('salutation') || '') as string;
        const fullName = salutation ? `${name}${salutation}` : name;
        const weddingDate = (fieldMap.get('weddingDate') || '') as string;
        const tables = parseInt(String(fieldMap.get('tables') || '0'), 10) || 0;
        const store = (fieldMap.get('store') || '') as string;
        const remark = (fieldMap.get('remark') || '') as string;
        const conn = await pool.getConnection();
        let submitId = 0;
        try {
            await conn.beginTransaction();

            // === 1. 写入 lead_submit 主表（每次都新增，保留历史） ===
            const [submitResult] = await conn.execute(
                `INSERT INTO lead_submit (phone, submit_type, raw_payload, created_at) VALUES (?, ?, ?, NOW())`,
                [phone, submitType || 0, JSON.stringify(body)]
            ) as any;
            submitId = submitResult.insertId;

            // === 2. 写入 lead_submit_field 子表 ===
            if (Array.isArray(data) && data.length > 0) {
                const values = data.map((field: any, index: number) => [
                    submitId,
                    field.fieldKey || '',
                    field.label || '',
                    field.mark || '',
                    field.mode || '',
                    JSON.stringify(field.value ?? ''),
                    field.showValue || '',
                    index,
                ]);
                await conn.query(
                    `INSERT INTO lead_submit_field (submit_id, field_key, label, mark, mode, value_json, show_value, sort_order)
                     VALUES ?`,
                    [values]
                );
            }

            // === 4. Upsert reservation（按手机号原子去重） ===
            let venueId: number | null = null;
            if (store) {
                const [venues] = await conn.execute(
                    'SELECT id FROM venue WHERE name LIKE ? AND is_active = 1 LIMIT 1',
                    [`%${store}%`]
                ) as any;
                if (venues.length > 0) venueId = venues[0].id;
            }

            await conn.execute(
                `INSERT INTO reservation (name, mobile, wedding_date, tables_count, venue_id, source, status, remark, submit_count, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, '小程序', '待跟进', ?, 1, NOW(), NOW())
                 ON DUPLICATE KEY UPDATE
                    submit_count = COALESCE(submit_count, 1) + 1,
                    updated_at = NOW()`,
                [fullName, phone, weddingDate, tables, venueId, remark]
            );

            await conn.commit();
        } catch (e) {
            try { await conn.rollback(); } catch (_) {}
            throw e;
        } finally {
            conn.release();
        }

        return c.json(ok({ submitId }));
    } catch (err: any) {
        log.error({ err }, 'api3 submit failed');
        return c.json({ errcode: 500, errmsg: '提交失败，请稍后重试' }, 500);
    }
});

// ========================
// 6. 其他杂项
// ========================
api3.post('/user/getPhoneNumber', (c) => {
    if (process.env.ALLOW_MOCK_PHONE_NUMBER === '1') {
        return c.json(ok({ phoneNumber: '13800138000', countryCode: '86' }));
    }

    return c.json({
        errcode: 501,
        errmsg: '未实现真实手机号解密，请改用 /api/wx/decrypt-phone 或显式开启 ALLOW_MOCK_PHONE_NUMBER=1',
        data: {}
    }, 501);
});

export default api3;
