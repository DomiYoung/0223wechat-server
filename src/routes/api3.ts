import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const api3 = new Hono();

// 数据目录
const DATA_DIR = path.join(__dirname, '../api_dump');

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

// ========================
// 1. 获取页面配置 (Core)
// ========================
api3.post('/zhan/xapp/page', async (c) => {
    try {
        const body = await c.req.json().catch(() => ({}));
        const { pageId, hash } = body;
        console.log(`[API3] Request Page: pageId=${pageId}, hash=${hash}`);

        // 定位文件
        let fileName = '';
        if (pageId) {
            const files = fs.readdirSync(DATA_DIR);
            fileName = files.find(f => f.includes(`page_`) && f.includes(`_${pageId}.json`)) || '';
        }
        
        if (!fileName && hash) {
            const files = fs.readdirSync(DATA_DIR);
            fileName = files.find(f => f.includes(`sub_`) && f.includes(`_${hash}.json`)) || '';
        }

        if (fileName) {
            const jsonPath = path.join(DATA_DIR, fileName);
            let rawData = fs.readFileSync(jsonPath, 'utf8');
            
            // 品牌动态替换
            rawData = applyBranding(rawData);
            
            const data = JSON.parse(rawData);
            return c.json(data);
        }

        // 回退首页
        console.warn(`[API3] Page not found (pageId=${pageId}, hash=${hash}), falling back to home`);
        const homePath = path.join(DATA_DIR, 'page_home_3692202.json');
        if (fs.existsSync(homePath)) {
            let homeData = fs.readFileSync(homePath, 'utf8');
            homeData = applyBranding(homeData);
            return c.json(JSON.parse(homeData));
        }

        return c.json(ok({ msg: 'no data' }), 404);
    } catch (err: any) {
        console.error('[API3] Page error:', err);
        return c.json({ errcode: 500, errmsg: err.message }, 500);
    }
});

// ========================
// 2. 登录与身份验证 (Auth)
// ========================
const getMockLoginResponse = async () => {
    try {
        const [rows] = await pool.execute('SELECT name, logo_url FROM brand WHERE is_active = 1 LIMIT 1') as any;
        const brand = rows[0] || { name: '嘉美麓德', logo_url: '' };
        
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
        const [rows] = await pool.execute('SELECT name, logo_url FROM brand WHERE is_active = 1 LIMIT 1') as any;
        const brand = rows[0] || { name: '嘉美麓德', logo_url: '' };
        
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
        const [caseCats] = await pool.execute('SELECT id, name FROM case_category WHERE is_active = 1 ORDER BY sort_order ASC') as any;
        const [pkgCats] = await pool.execute('SELECT id, name FROM package_category WHERE is_active = 1 ORDER BY sort_order ASC') as any;
        
        const classifyList = [
            ...caseCats.map((cc: any) => ({ id: cc.id, name: cc.name, type: 1 })),
            ...pkgCats.map((pc: any) => ({ id: pc.id, name: pc.name, type: 2 }))
        ];

        return c.json(ok({
            classifyList,
            total: classifyList.length
        }));
    } catch (e) {
        console.error('DB Fetch Error (Classify):', e);
        const classifyPath = path.join(DATA_DIR, 'cms_classify.json');
        if (fs.existsSync(classifyPath)) {
            let content = fs.readFileSync(classifyPath, 'utf8');
            content = applyBranding(content);
            const data = JSON.parse(content);
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
        console.error('DB Fetch Error (Content):', e);
        const listPath = path.join(DATA_DIR, 'cms_list.json');
        if (fs.existsSync(listPath)) {
            let content = fs.readFileSync(listPath, 'utf8');
            content = applyBranding(content);
            const data = JSON.parse(content);
            if (data.errcode === 0) return c.json(data);
        }
        return c.json(ok({ list: [], total: 0 }));
    }
});

api3.post('/zhan/xapp/getPageData', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    console.log(`[API3] Request CMS Detail:`, body);
    return c.json(ok({})); 
});

// ========================
// 5. 其他杂项
// ========================
api3.post('/user/getPhoneNumber', (c) => c.json(ok({ phoneNumber: '13800138000', countryCode: '86' })));

export default api3;
