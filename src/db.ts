import 'dotenv/config';
import mysql from 'mysql2/promise';
import { hashAdminPassword } from './security/admin-auth.js';

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wedding_cms',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
});

export default pool;

/**
 * 初始化数据库表结构
 * - 使用 IF NOT EXISTS 保证幂等
 * - 所有字符串列使用 utf8mb4 支持 emoji
 * - 索引设计遵循最左前缀原则，覆盖常用查询场景
 */
export async function initDB() {
    const db = pool;

    // 1. admin — 管理员账户
    await db.execute(`
        CREATE TABLE IF NOT EXISTS admin (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) NOT NULL UNIQUE COMMENT '登录用户名',
            password_hash VARCHAR(255) NOT NULL COMMENT '密码哈希',
            display_name VARCHAR(50) DEFAULT '' COMMENT '显示名称',
            role ENUM('super','editor','viewer') DEFAULT 'editor' COMMENT '角色',
            is_active TINYINT(1) DEFAULT 1 COMMENT '是否启用',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员'
    `);

    // 确保 admin 表有 is_active 列（兼容旧数据库）
    try {
        await db.execute(`ALTER TABLE admin ADD COLUMN is_active TINYINT(1) DEFAULT 1 COMMENT '是否启用' AFTER role`);
    } catch (_) { /* 列已存在则忽略 */ }

    // 2. config — 全局配置 KV
    await db.execute(`
        CREATE TABLE IF NOT EXISTS config (
            id INT AUTO_INCREMENT PRIMARY KEY,
            config_key VARCHAR(100) NOT NULL UNIQUE COMMENT '配置键',
            config_value TEXT COMMENT '配置值',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='全局配置'
    `);

    // 3. city — 城市管理（聚合根）
    await db.execute(`
        CREATE TABLE IF NOT EXISTS city (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(20) NOT NULL UNIQUE COMMENT '城市名称',
            region VARCHAR(20) DEFAULT '' COMMENT '区域(华东/华北/华南)',
            sort_order INT DEFAULT 0 COMMENT '排序权重',
            is_active TINYINT(1) DEFAULT 1 COMMENT '是否启用',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_active_sort (is_active, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='城市管理'
    `);

    // 4. venue — 门店场地
    await db.execute(`
        CREATE TABLE IF NOT EXISTS venue (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL COMMENT '门店名称',
            city VARCHAR(20) NOT NULL DEFAULT '' COMMENT '(旧)所属城市文本',
            city_id INT DEFAULT NULL COMMENT '关联城市',
            address VARCHAR(255) DEFAULT '' COMMENT '详细地址',
            phone VARCHAR(50) DEFAULT '' COMMENT '联系电话',
            cover_url TEXT COMMENT '门店封面图',
            lat DECIMAL(10,7) DEFAULT NULL COMMENT '纬度',
            lng DECIMAL(10,7) DEFAULT NULL COMMENT '经度',
            business_hours VARCHAR(100) DEFAULT '' COMMENT '营业时间',
            is_active TINYINT(1) DEFAULT 1 COMMENT '是否启用',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_city_active (city, is_active),
            INDEX idx_city_id (city_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='门店场地'
    `);

    // 确保 venue 表有 city_id 列（兼容旧数据库）
    try {
        await db.execute(`ALTER TABLE venue ADD COLUMN city_id INT DEFAULT NULL COMMENT '关联城市' AFTER city`);
        await db.execute(`ALTER TABLE venue ADD INDEX idx_city_id (city_id)`);
    } catch (_) { /* 列已存在则忽略 */ }

    // 5. wedding_case — 婚礼主题/案例
    await db.execute(`
        CREATE TABLE IF NOT EXISTS wedding_case (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(100) NOT NULL COMMENT '主题名称',
            tag VARCHAR(50) DEFAULT '' COMMENT '价格标签',
            hall_name VARCHAR(100) DEFAULT '' COMMENT '展厅名称',
            style VARCHAR(50) DEFAULT '' COMMENT '旧字段(兼容): 风格/展厅',
            wedding_date VARCHAR(50) DEFAULT '' COMMENT '婚礼日期',
            shop_label VARCHAR(50) DEFAULT '' COMMENT '原始数据标识',
            description TEXT COMMENT '详细描述',
            cover_url TEXT COMMENT '封面图URL',
            venue_id INT DEFAULT NULL COMMENT '所属门店',
            sort_order INT DEFAULT 0 COMMENT '排序权重',
            is_featured TINYINT(1) DEFAULT 0 COMMENT '首页推荐',
            is_active TINYINT(1) DEFAULT 1 COMMENT '是否上线',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_venue_active (venue_id, is_active),
            INDEX idx_featured (is_featured, is_active),
            INDEX idx_sort_id (sort_order, id),
            INDEX idx_title (title(50)),
            FOREIGN KEY fk_venue (venue_id) REFERENCES venue(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='婚礼主题'
    `);

    // 确保 wedding_case 表有 hall_name 列（兼容旧数据库）
    try {
        await db.execute(`ALTER TABLE wedding_case ADD COLUMN hall_name VARCHAR(100) DEFAULT '' COMMENT '展厅名称' AFTER tag`);
    } catch (_) { /* 列已存在则忽略 */ }

    // 数据回填：hall_name 为空时，用旧 style 补齐
    await db.execute(
        `UPDATE wedding_case
         SET hall_name = style
         WHERE (hall_name IS NULL OR hall_name = '')
           AND style IS NOT NULL
           AND style <> ''`
    );

    // 6. case_image — 主题详情图集
    await db.execute(`
        CREATE TABLE IF NOT EXISTS case_image (
            id INT AUTO_INCREMENT PRIMARY KEY,
            case_id INT NOT NULL COMMENT '所属主题ID',
            image_url TEXT NOT NULL COMMENT '图片地址',
            sort_order INT DEFAULT 0 COMMENT '排序',
            INDEX idx_case_sort (case_id, sort_order),
            FOREIGN KEY (case_id) REFERENCES wedding_case(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='主题图集'
    `);

    // 7. reservation — 客资预约 CRM
    await db.execute(`
        CREATE TABLE IF NOT EXISTS reservation (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(50) NOT NULL COMMENT '客户姓名',
            mobile VARCHAR(20) NOT NULL COMMENT '手机号',
            wechat_openid VARCHAR(64) DEFAULT NULL COMMENT '微信OpenID',
            wedding_date VARCHAR(50) DEFAULT '' COMMENT '婚期',
            tables_count INT DEFAULT 0 COMMENT '桌数',
            venue_id INT DEFAULT NULL COMMENT '意向门店',
            case_id INT DEFAULT NULL COMMENT '来源主题',
            source VARCHAR(50) DEFAULT '小程序' COMMENT '来源渠道',
            sub_platform VARCHAR(50) DEFAULT '' COMMENT '子平台标识',
            city VARCHAR(20) DEFAULT '' COMMENT '(旧)意向城市文本',
            city_id INT DEFAULT NULL COMMENT '关联城市',
            status ENUM('待跟进','已联系','已签约','无效') DEFAULT '待跟进' COMMENT '跟进状态',
            remark TEXT COMMENT '跟进备注',
            lead_meta JSON COMMENT '留资扩展信息',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_mobile (mobile),
            INDEX idx_status_created (status, created_at DESC),
            INDEX idx_created (created_at DESC),
            INDEX idx_city_status (city, status),
            INDEX idx_city_id (city_id),
            INDEX idx_openid (wechat_openid),
            FOREIGN KEY fk_res_venue (venue_id) REFERENCES venue(id) ON DELETE SET NULL,
            FOREIGN KEY fk_res_case (case_id) REFERENCES wedding_case(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='客资预约CRM'
    `);

    // 确保 reservation 表有 city_id 列（兼容旧数据库）
    try {
        await db.execute(`ALTER TABLE reservation ADD COLUMN city_id INT DEFAULT NULL COMMENT '关联城市' AFTER city`);
        await db.execute(`ALTER TABLE reservation ADD INDEX idx_city_id (city_id)`);
    } catch (_) { /* 列已存在则忽略 */ }
    try {
        await db.execute(`ALTER TABLE reservation ADD COLUMN lead_meta JSON COMMENT '留资扩展信息' AFTER remark`);
    } catch (_) { /* 列已存在则忽略 */ }
    try {
        await db.execute(`ALTER TABLE reservation ADD COLUMN submit_count INT DEFAULT 1 COMMENT '提交次数' AFTER lead_meta`);
    } catch (_) { /* 列已存在则忽略 */ }
    try {
        await db.execute('CREATE UNIQUE INDEX uk_reservation_mobile ON reservation(mobile)');
    } catch (_) { /* 索引已存在则忽略 */ }

    // 8. lead_auth_log — 手机号授权获客日志
    await db.execute(`
        CREATE TABLE IF NOT EXISTS lead_auth_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            mobile VARCHAR(20) NOT NULL COMMENT '手机号',
            country_code VARCHAR(10) DEFAULT '86' COMMENT '国家区号',
            city VARCHAR(20) DEFAULT '' COMMENT '城市',
            source VARCHAR(100) DEFAULT '' COMMENT '来源标识',
            submit_type INT DEFAULT 0 COMMENT '提交类型',
            channel_id INT DEFAULT 0 COMMENT '渠道ID',
            mark VARCHAR(50) DEFAULT '' COMMENT '标记',
            page_path VARCHAR(255) DEFAULT '' COMMENT '页面路径',
            wid VARCHAR(64) DEFAULT '' COMMENT '用户wid',
            open_id VARCHAR(64) DEFAULT '' COMMENT '微信openid',
            
            -- 新增的 1:1 关键关联字段
            pid VARCHAR(50) DEFAULT '' COMMENT '商户PID',
            zhan_id VARCHAR(50) DEFAULT '' COMMENT '微站ID',
            form_id VARCHAR(64) DEFAULT '' COMMENT '表单ID',
            page_id VARCHAR(64) DEFAULT '' COMMENT '页面ID',
            mark_id VARCHAR(64) DEFAULT '' COMMENT '追踪ID',
            url TEXT COMMENT '来源URL',
            channel VARCHAR(50) DEFAULT '' COMMENT '渠道',
            wx_decrypt_data JSON COMMENT '微信手机号原始解密结果',
            
            extra_meta JSON COMMENT '扩展数据',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_mobile_created (mobile, created_at DESC),
            INDEX idx_source_created (source(50), created_at DESC),
            INDEX idx_wid_created (wid, created_at DESC),
            INDEX idx_openid_created (open_id, created_at DESC),
            INDEX idx_page_form_created (page_id, form_id, created_at DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='手机号授权获客日志'
    `);

    // 兼容原表增加列与索引
    try { await db.execute('ALTER TABLE lead_auth_log ADD COLUMN pid VARCHAR(50) DEFAULT "" AFTER open_id'); } catch (e) {}
    try { await db.execute('ALTER TABLE lead_auth_log ADD COLUMN zhan_id VARCHAR(50) DEFAULT ""'); } catch (e) {}
    try { await db.execute('ALTER TABLE lead_auth_log ADD COLUMN form_id VARCHAR(64) DEFAULT ""'); } catch (e) {}
    try { await db.execute('ALTER TABLE lead_auth_log ADD COLUMN page_id VARCHAR(64) DEFAULT ""'); } catch (e) {}
    try { await db.execute('ALTER TABLE lead_auth_log ADD COLUMN mark_id VARCHAR(64) DEFAULT ""'); } catch (e) {}
    try { await db.execute('ALTER TABLE lead_auth_log ADD COLUMN url TEXT'); } catch (e) {}
    try { await db.execute('ALTER TABLE lead_auth_log ADD COLUMN channel VARCHAR(50) DEFAULT ""'); } catch (e) {}
    try { await db.execute('ALTER TABLE lead_auth_log ADD COLUMN wx_decrypt_data JSON'); } catch (e) {}
    try { await db.execute('CREATE INDEX idx_wid_created ON lead_auth_log(wid, created_at DESC)'); } catch (e) {}
    try { await db.execute('CREATE INDEX idx_openid_created ON lead_auth_log(open_id, created_at DESC)'); } catch (e) {}
    try { await db.execute('CREATE INDEX idx_page_form_created ON lead_auth_log(page_id, form_id, created_at DESC)'); } catch (e) {}

    // 8.1 lead_submit — 原始提交主表 (1:1 复刻留资)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS lead_submit (
            id INT AUTO_INCREMENT PRIMARY KEY,
            pid VARCHAR(50) DEFAULT '' COMMENT '商户PID',
            zhan_id VARCHAR(50) DEFAULT '' COMMENT '微站ID',
            wid VARCHAR(64) DEFAULT '' COMMENT '用户wid',
            uwid VARCHAR(64) DEFAULT '' COMMENT 'UnionWID',
            open_id VARCHAR(64) DEFAULT '' COMMENT '微信openid',
            form_id VARCHAR(64) DEFAULT '' COMMENT '表单ID',
            page_id VARCHAR(64) DEFAULT '' COMMENT '页面ID',
            submit_type INT DEFAULT 0 COMMENT '提交类型',
            channel_id INT DEFAULT 0 COMMENT '渠道ID',
            mark_id VARCHAR(64) DEFAULT '' COMMENT '追踪markId',
            draw_id VARCHAR(64) DEFAULT '' COMMENT '抽奖ID',
            dialog_id VARCHAR(64) DEFAULT '' COMMENT '弹窗ID',
            submit_button_id VARCHAR(64) DEFAULT '' COMMENT '按钮ID',
            url TEXT COMMENT '页面URL',
            phone VARCHAR(20) DEFAULT '' COMMENT '留资手机号',
            region_code VARCHAR(10) DEFAULT '' COMMENT '区号',
            origin_phone VARCHAR(20) DEFAULT '' COMMENT '原始手机号',
            raw_payload JSON COMMENT '提交的完整参数',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_wid (wid),
            INDEX idx_phone (phone),
            INDEX idx_form_page (form_id, page_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='原始提交主表'
    `);

    // 8.2 lead_submit_field — 提交明细子表
    await db.execute(`
        CREATE TABLE IF NOT EXISTS lead_submit_field (
            id INT AUTO_INCREMENT PRIMARY KEY,
            submit_id INT NOT NULL COMMENT '关联的提交主表ID',
            field_key VARCHAR(100) DEFAULT '' COMMENT '字段key (如name/phone)',
            label VARCHAR(100) DEFAULT '' COMMENT '标签 (如姓名)',
            mark VARCHAR(100) DEFAULT '' COMMENT '标记',
            mode VARCHAR(50) DEFAULT '' COMMENT '类型/模式',
            value_json JSON COMMENT '真实存的值(用于复原)',
            show_value TEXT COMMENT '展示的拼装值',
            sort_order INT DEFAULT 0 COMMENT '排序',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_submit_id (submit_id),
            FOREIGN KEY (submit_id) REFERENCES lead_submit(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='提交明细子表'
    `);

    // 9. audit_log — 操作审计日志
    await db.execute(`
        CREATE TABLE IF NOT EXISTS audit_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            admin_id INT DEFAULT NULL COMMENT '操作人',
            action VARCHAR(20) NOT NULL COMMENT 'CREATE/UPDATE/DELETE',
            target_table VARCHAR(50) NOT NULL COMMENT '目标表',
            target_id INT DEFAULT NULL COMMENT '目标行ID',
            old_value JSON COMMENT '变更前快照',
            new_value JSON COMMENT '变更后快照',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_admin_time (admin_id, created_at),
            INDEX idx_target (target_table, target_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作审计日志'
    `);

    // ============================================================
    // 0305 扩展表：品牌
    // ============================================================
    await db.execute(`
        CREATE TABLE IF NOT EXISTS brand (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL COMMENT '品牌名称',
            logo_url TEXT COMMENT 'Logo图',
            slogan VARCHAR(200) DEFAULT '' COMMENT '标语',
            description TEXT COMMENT '品牌介绍(富文本)',
            contact_phone VARCHAR(50) DEFAULT '' COMMENT '品牌总机',
            contact_wechat VARCHAR(50) DEFAULT '' COMMENT '微信号',
            is_active TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='品牌'
    `);

    // venue 扩展: 增加 brand_id
    try { await db.execute('ALTER TABLE venue ADD COLUMN brand_id INT DEFAULT NULL COMMENT \'所属品牌\' AFTER name'); } catch (_) {}
    try { await db.execute('ALTER TABLE venue ADD INDEX idx_brand_id (brand_id)'); } catch (_) {}

    // ============================================================
    // 0305 扩展表：案例分类
    // ============================================================
    await db.execute(`
        CREATE TABLE IF NOT EXISTS case_category (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(50) NOT NULL COMMENT '分类名: 婚礼案例/婚礼攻略',
            sort_order INT DEFAULT 0,
            is_active TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='案例分类'
    `);

    // wedding_case 扩展: 增加 category_id, content, views, likes
    try { await db.execute('ALTER TABLE wedding_case ADD COLUMN category_id INT DEFAULT NULL COMMENT \'案例分类\' AFTER venue_id'); } catch (_) {}
    try { await db.execute('ALTER TABLE wedding_case ADD COLUMN content TEXT COMMENT \'富文本详情\' AFTER description'); } catch (_) {}
    try { await db.execute('ALTER TABLE wedding_case ADD COLUMN views INT DEFAULT 0 COMMENT \'浏览量\' AFTER content'); } catch (_) {}
    try { await db.execute('ALTER TABLE wedding_case ADD COLUMN likes INT DEFAULT 0 COMMENT \'点赞数\' AFTER views'); } catch (_) {}
    try { await db.execute('ALTER TABLE wedding_case ADD INDEX idx_category (category_id)'); } catch (_) {}
    try { await db.execute('CREATE INDEX idx_active_sort_id ON wedding_case(is_active, sort_order, id)'); } catch (_) {}
    try { await db.execute('CREATE INDEX idx_active_category ON wedding_case(is_active, category_id)'); } catch (_) {}
    try { await db.execute('CREATE INDEX idx_venue_featured_active_sort ON wedding_case(venue_id, is_featured, is_active, sort_order, id)'); } catch (_) {}

    // ============================================================
    // 0305 扩展表：套餐分类（独立业务线，不关联品牌）
    // ============================================================
    await db.execute(`
        CREATE TABLE IF NOT EXISTS package_category (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL COMMENT '婚宴菜单/婚庆套餐/生日宴/儿童宴/商务宴会',
            slug VARCHAR(50) UNIQUE COMMENT 'URL标识',
            cover_url TEXT COMMENT '分类封面图',
            sort_order INT DEFAULT 0,
            is_active TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐分类'
    `);

    // ============================================================
    // 0305 扩展表：套餐
    // ============================================================
    await db.execute(`
        CREATE TABLE IF NOT EXISTS package (
            id INT AUTO_INCREMENT PRIMARY KEY,
            category_id INT NOT NULL COMMENT '所属分类',
            title VARCHAR(200) NOT NULL COMMENT '套餐名称',
            cover_url TEXT COMMENT '封面图',
            price DECIMAL(10,2) DEFAULT NULL COMMENT '价格',
            price_label VARCHAR(50) DEFAULT '' COMMENT '价格标签文字',
            tag VARCHAR(50) DEFAULT '' COMMENT '标签: 热门/推荐',
            description TEXT COMMENT '套餐描述(富文本)',
            sort_order INT DEFAULT 0,
            is_active TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES package_category(id) ON DELETE CASCADE,
            INDEX idx_category_active (category_id, is_active),
            INDEX idx_sort (sort_order, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐'
    `);
    try { await db.execute('CREATE INDEX idx_category_active_sort ON package(category_id, is_active, sort_order, id)'); } catch (_) {}

    // ============================================================
    // 0305 扩展表：套餐图集
    // ============================================================
    await db.execute(`
        CREATE TABLE IF NOT EXISTS package_image (
            id INT AUTO_INCREMENT PRIMARY KEY,
            package_id INT NOT NULL,
            image_url TEXT NOT NULL COMMENT '图片地址',
            sort_order INT DEFAULT 0,
            FOREIGN KEY (package_id) REFERENCES package(id) ON DELETE CASCADE,
            INDEX idx_pkg_sort (package_id, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐图集'
    `);

    // ============================================================
    // 0305 扩展表：门店环境图集
    // ============================================================
    await db.execute(`
        CREATE TABLE IF NOT EXISTS venue_image (
            id INT AUTO_INCREMENT PRIMARY KEY,
            venue_id INT NOT NULL,
            image_url TEXT NOT NULL COMMENT '图片地址',
            sort_order INT DEFAULT 0,
            FOREIGN KEY (venue_id) REFERENCES venue(id) ON DELETE CASCADE,
            INDEX idx_venue_sort (venue_id, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='门店环境图集'
    `);

    // venue 扩展: 增加 metro_info / description
    try { await db.execute('ALTER TABLE venue ADD COLUMN metro_info VARCHAR(200) DEFAULT \'\' COMMENT \'地铁信息\' AFTER business_hours'); } catch (_) {}
    try { await db.execute('ALTER TABLE venue ADD COLUMN description TEXT COMMENT \'门店描述\' AFTER metro_info'); } catch (_) {}
    try { await db.execute('CREATE INDEX idx_brand_active_id ON venue(brand_id, is_active, id)'); } catch (_) {}

    // ============================================================
    // 0305 扩展表：页面动态配置 (CMS可编辑)
    // ============================================================
    await db.execute(`
        CREATE TABLE IF NOT EXISTS page_config (
            id INT AUTO_INCREMENT PRIMARY KEY,
            page_key VARCHAR(50) UNIQUE NOT NULL COMMENT '页面标识: home/cases/birthday/store/about',
            title VARCHAR(100) COMMENT '页面标题',
            bg_color VARCHAR(20) DEFAULT '#ffffff',
            elements_json JSON NOT NULL COMMENT '组件列表(Banner/Text/Grid/Form等)',
            bottom_nav_json JSON COMMENT '底部导航配置',
            music_url TEXT COMMENT '背景音乐URL',
            is_active TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='页面动态配置(CMS可编辑)'
    `);

    // ============================================================
    // 0305 扩展表：小程序用户
    // ============================================================
    await db.execute(`
        CREATE TABLE IF NOT EXISTS wx_user (
            id INT AUTO_INCREMENT PRIMARY KEY,
            openid VARCHAR(100) UNIQUE COMMENT '微信openid',
            unionid VARCHAR(100) COMMENT '微信unionid',
            nickname VARCHAR(100) COMMENT '昵称',
            avatar_url TEXT COMMENT '头像',
            phone VARCHAR(20) COMMENT '手机号',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_phone (phone)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='小程序用户'
    `);

    // ============================================================
    // 0305 扩展表：用户订阅消息记录
    // ============================================================
    await db.execute(`
        CREATE TABLE IF NOT EXISTS user_subscribe (
            id INT AUTO_INCREMENT PRIMARY KEY,
            open_id VARCHAR(100) NOT NULL COMMENT '用户OpenID',
            template_id VARCHAR(100) NOT NULL COMMENT '模板ID',
            biz_type VARCHAR(50) NOT NULL COMMENT '业务类型',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
            UNIQUE KEY uk_openid_biztype_template (open_id, biz_type, template_id),
            INDEX idx_openid (open_id),
            INDEX idx_biztype (biz_type),
            INDEX idx_openid_biztype_updated (open_id, biz_type, updated_at, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户订阅消息记录'
    `);

    // ============================================================
    // 0305 扩展表：短信发送记录
    // ============================================================
    await db.execute(`
        CREATE TABLE IF NOT EXISTS sms_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            phone VARCHAR(20) NOT NULL COMMENT '接收手机号',
            template_code VARCHAR(50) NOT NULL COMMENT '短信模板ID',
            template_param JSON COMMENT '模板参数',
            biz_id VARCHAR(100) DEFAULT NULL COMMENT '阿里云返回的BizId',
            status ENUM('success','failed') NOT NULL COMMENT '发送状态',
            error_message TEXT COMMENT '错误信息',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间',
            INDEX idx_phone_created (phone, created_at DESC),
            INDEX idx_status_created (status, created_at DESC),
            INDEX idx_template (template_code),
            INDEX idx_bizid (biz_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='短信发送记录'
    `);

    // ============================================================
    // 数据迁移：从 venue/reservation 的 city 文本迁移到 city 表
    // ============================================================
    await migrateCityData(db);
    await ensureUserSubscribeUniqueByBizType();
    await ensureCoreForeignKeys();

    // ============================================================
    // 种子数据（仅首次启动时填充）
    // ============================================================
    const [adminRows] = await db.execute('SELECT COUNT(*) as count FROM admin') as any;
    if (adminRows[0].count === 0) {
        const defaultAdminPasswordHash = await hashAdminPassword('wedding2024');
        await db.execute(
            'INSERT INTO admin (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
            ['admin', defaultAdminPasswordHash, '超级管理员', 'super']
        );
        console.log('👤 默认管理员已创建: admin / wedding2024');
    }

    const [venueRows] = await db.execute('SELECT COUNT(*) as count FROM venue') as any;
    if (venueRows[0].count === 0) {
        // 先插入种子城市
        const seedCities = [
            { name: '上海', region: '华东', sort_order: 1 },
            { name: '北京', region: '华北', sort_order: 2 },
            { name: '南京', region: '华东', sort_order: 3 },
        ];
        for (const c of seedCities) {
            await db.execute(
                'INSERT IGNORE INTO city (name, region, sort_order) VALUES (?, ?, ?)',
                [c.name, c.region, c.sort_order]
            );
        }

        const [cityRows] = await db.execute('SELECT id, name FROM city') as any;
        const cityMap = new Map(cityRows.map((r: any) => [r.name, r.id]));

        const venues = [
            { name: '花嫁丽舍·外滩店', city: '上海', address: '上海市黄浦区外滩xx号', phone: '021-12345678' },
            { name: '花嫁丽舍·国贸店', city: '北京', address: '北京市朝阳区国贸xx号', phone: '010-12345678' },
            { name: '花嫁丽舍·新街口店', city: '南京', address: '南京市玄武区新街口xx号', phone: '025-12345678' },
        ];
        for (const v of venues) {
            await db.execute(
                'INSERT INTO venue (name, city, city_id, address, phone) VALUES (?, ?, ?, ?, ?)',
                [v.name, v.city, cityMap.get(v.city) || null, v.address, v.phone]
            );
        }
        console.log('🏠 默认门店已创建（上海/北京/南京）');
    }

    // 案例分类种子数据
    const [caseCatRows] = await db.execute('SELECT COUNT(*) as count FROM case_category') as any;
    if (caseCatRows[0].count === 0) {
        await db.execute("INSERT INTO case_category (name, sort_order) VALUES ('婚礼案例', 1), ('婚礼攻略', 2), ('生日宴', 3), ('商务', 4)");
        console.log('📂 案例分类已创建: 婚礼案例 / 婚礼攻略 / 生日宴 / 商务');
    } else {
        // 兼容已有数据的生产库：确保"生日宴"和"商务"分类存在
        await db.execute("INSERT IGNORE INTO case_category (name, sort_order) VALUES ('生日宴', 3), ('商务', 4)");
    }

    // 套餐分类种子数据
    const [pkgCatRows] = await db.execute('SELECT COUNT(*) as count FROM package_category') as any;
    if (pkgCatRows[0].count === 0) {
        await db.execute(`INSERT INTO package_category (name, slug, sort_order) VALUES
            ('婚宴菜单', 'wedding_menu', 1),
            ('婚庆套餐', 'wedding_pkg', 2),
            ('生日宴', 'birthday', 3),
            ('儿童宴', 'kids', 4),
            ('商务宴会', 'business', 5)
        `);
        console.log('📦 套餐分类已创建: 婚宴菜单 / 婚庆套餐 / 生日宴 / 儿童宴 / 商务宴会');
    }

    console.log('✅ 数据库初始化完毕 — 16张表全部就绪');
}

export async function ensureReservationMobileUnique() {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // 0) 先标准化手机号，避免因为空格或空串导致唯一索引创建失败
        await conn.execute(`
            UPDATE reservation
            SET mobile = TRIM(mobile)
            WHERE mobile <> TRIM(mobile)
        `);
        await conn.execute(`
            UPDATE reservation
            SET mobile = CONCAT('_invalid_', id)
            WHERE mobile IS NULL OR mobile = ''
        `);

        // 1) 清理历史重复 mobile：保留 submit_count 最大/更新时间最新的一条，其余合并计数后删除
        // 说明：在没有唯一索引之前，线上可能已经产生重复 mobile。
        // 合并策略：
        // - keep_id 取 updated_at 最大的那条（updated_at 相同则 id 最大）
        // - submit_count 合并为 SUM(submit_count)（为空按 1 计）
        // - 其余字段保持 keep_id 那条的值，不做字段层合并（避免误覆盖）
        await conn.execute('DROP TEMPORARY TABLE IF EXISTS tmp_res_keep');
        await conn.execute(`
            CREATE TEMPORARY TABLE tmp_res_keep AS
            SELECT x.mobile, x.keep_id, x.total_submit
            FROM (
                SELECT
                    r.mobile,
                    SUBSTRING_INDEX(
                        GROUP_CONCAT(r.id ORDER BY r.updated_at DESC, r.id DESC),
                        ',', 1
                    ) AS keep_id,
                    SUM(COALESCE(NULLIF(r.submit_count, 0), 1)) AS total_submit,
                    COUNT(*) AS cnt
                FROM reservation r
                WHERE r.mobile IS NOT NULL AND r.mobile <> ''
                GROUP BY r.mobile
                HAVING cnt > 1
            ) x
        `);

        // 合并 submit_count 到保留行
        await conn.execute(`
            UPDATE reservation r
            INNER JOIN tmp_res_keep t ON t.keep_id = r.id
            SET r.submit_count = t.total_submit
        `);

        // 删除重复行
        await conn.execute(`
            DELETE r
            FROM reservation r
            INNER JOIN tmp_res_keep t ON t.mobile = r.mobile
            WHERE r.id <> t.keep_id
        `);

        // 2) 创建唯一索引（幂等）
        try {
            await conn.execute('CREATE UNIQUE INDEX uk_reservation_mobile ON reservation(mobile)');
        } catch (_) {
            // index exists or can't be created; ignore here
        }

        await conn.commit();
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        throw err;
    } finally {
        conn.release();
    }
}

export async function ensureUserSubscribeUniqueByBizType() {
    const conn = await pool.getConnection();
    try {
        // 允许在 migrations 阶段独立运行：如果表还不存在，直接跳过。
        const [tables] = await conn.query(`SHOW TABLES LIKE 'user_subscribe'`) as any;
        if (!Array.isArray(tables) || tables.length === 0) return;

        await conn.beginTransaction();
        await conn.execute(`
            UPDATE user_subscribe
            SET biz_type = 'general'
            WHERE biz_type IS NULL OR biz_type = ''
        `);

        await conn.execute('DROP TEMPORARY TABLE IF EXISTS tmp_user_subscribe_keep');
        await conn.execute(`
            CREATE TEMPORARY TABLE tmp_user_subscribe_keep AS
            SELECT
                x.open_id,
                x.template_id,
                x.biz_type,
                x.keep_id
            FROM (
                SELECT
                    us.open_id,
                    us.template_id,
                    us.biz_type,
                    SUBSTRING_INDEX(
                        GROUP_CONCAT(us.id ORDER BY us.updated_at DESC, us.id DESC),
                        ',', 1
                    ) AS keep_id,
                    COUNT(*) AS cnt
                FROM user_subscribe us
                GROUP BY us.open_id, us.template_id, us.biz_type
                HAVING cnt > 1
            ) x
        `);

        await conn.execute(`
            DELETE us
            FROM user_subscribe us
            INNER JOIN tmp_user_subscribe_keep t
                ON t.open_id = us.open_id
               AND t.template_id = us.template_id
               AND t.biz_type = us.biz_type
            WHERE us.id <> t.keep_id
        `);
        await conn.commit();

        try { await conn.execute('DROP INDEX uk_openid_template ON user_subscribe'); } catch (_) {}
        try { await conn.execute('CREATE UNIQUE INDEX uk_openid_biztype_template ON user_subscribe(open_id, biz_type, template_id)'); } catch (_) {}
        try { await conn.execute('CREATE INDEX idx_openid_biztype_updated ON user_subscribe(open_id, biz_type, updated_at, id)'); } catch (_) {}
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        throw err;
    } finally {
        conn.release();
    }
}

export async function ensureCoreForeignKeys() {
    const conn = await pool.getConnection();
    try {
        // migrations 阶段允许独立运行：如果核心表不存在，直接跳过。
        const [venueTables] = await conn.query(`SHOW TABLES LIKE 'venue'`) as any;
        const [brandTables] = await conn.query(`SHOW TABLES LIKE 'brand'`) as any;
        const [caseTables] = await conn.query(`SHOW TABLES LIKE 'wedding_case'`) as any;
        const [caseCatTables] = await conn.query(`SHOW TABLES LIKE 'case_category'`) as any;
        const [cityTables] = await conn.query(`SHOW TABLES LIKE 'city'`) as any;
        const [reservationTables] = await conn.query(`SHOW TABLES LIKE 'reservation'`) as any;
        if (!Array.isArray(venueTables) || venueTables.length === 0) return;
        if (!Array.isArray(caseTables) || caseTables.length === 0) return;

        // 先清理历史脏数据，再补外键约束，避免直接加约束失败。
        await conn.beginTransaction();

        const [venueBrandCol] = await conn.query(`SHOW COLUMNS FROM venue LIKE 'brand_id'`) as any;
        const hasVenueBrand = Array.isArray(venueBrandCol) && venueBrandCol.length > 0;
        const [caseCatCol] = await conn.query(`SHOW COLUMNS FROM wedding_case LIKE 'category_id'`) as any;
        const hasCaseCategory = Array.isArray(caseCatCol) && caseCatCol.length > 0;
        const [venueCityCol] = await conn.query(`SHOW COLUMNS FROM venue LIKE 'city_id'`) as any;
        const hasVenueCityId = Array.isArray(venueCityCol) && venueCityCol.length > 0;
        const [resCityCol] = await conn.query(`SHOW COLUMNS FROM reservation LIKE 'city_id'`) as any;
        const hasReservationCityId = Array.isArray(resCityCol) && resCityCol.length > 0;

        if (hasVenueBrand && Array.isArray(brandTables) && brandTables.length > 0) {
            await conn.execute(`
                UPDATE venue v
                LEFT JOIN brand b ON b.id = v.brand_id
                SET v.brand_id = NULL
                WHERE v.brand_id IS NOT NULL AND b.id IS NULL
            `);
        }
        if (hasCaseCategory && Array.isArray(caseCatTables) && caseCatTables.length > 0) {
            await conn.execute(`
                UPDATE wedding_case wc
                LEFT JOIN case_category cc ON cc.id = wc.category_id
                SET wc.category_id = NULL
                WHERE wc.category_id IS NOT NULL AND cc.id IS NULL
            `);
        }
        if (hasVenueCityId && Array.isArray(cityTables) && cityTables.length > 0) {
            await conn.execute(`
                UPDATE venue v
                LEFT JOIN city c ON c.id = v.city_id
                SET v.city_id = NULL
                WHERE v.city_id IS NOT NULL AND c.id IS NULL
            `);
        }
        if (
            hasReservationCityId &&
            Array.isArray(cityTables) && cityTables.length > 0 &&
            Array.isArray(reservationTables) && reservationTables.length > 0
        ) {
            await conn.execute(`
                UPDATE reservation r
                LEFT JOIN city c ON c.id = r.city_id
                SET r.city_id = NULL
                WHERE r.city_id IS NOT NULL AND c.id IS NULL
            `);
        }
        await conn.commit();

        if (hasVenueCityId && Array.isArray(cityTables) && cityTables.length > 0) {
            try { await conn.execute('ALTER TABLE venue ADD CONSTRAINT fk_venue_city FOREIGN KEY (city_id) REFERENCES city(id) ON DELETE SET NULL'); } catch (_) {}
        }
        if (hasReservationCityId && Array.isArray(cityTables) && cityTables.length > 0 && Array.isArray(reservationTables) && reservationTables.length > 0) {
            try { await conn.execute('ALTER TABLE reservation ADD CONSTRAINT fk_res_city FOREIGN KEY (city_id) REFERENCES city(id) ON DELETE SET NULL'); } catch (_) {}
        }
        if (hasVenueBrand && Array.isArray(brandTables) && brandTables.length > 0) {
            try { await conn.execute('ALTER TABLE venue ADD CONSTRAINT fk_venue_brand FOREIGN KEY (brand_id) REFERENCES brand(id) ON DELETE SET NULL'); } catch (_) {}
        }
        if (hasCaseCategory && Array.isArray(caseCatTables) && caseCatTables.length > 0) {
            try { await conn.execute('ALTER TABLE wedding_case ADD CONSTRAINT fk_case_category FOREIGN KEY (category_id) REFERENCES case_category(id) ON DELETE SET NULL'); } catch (_) {}
        }
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * 迁移逻辑：从 venue.city / reservation.city 文本字段回填 city_id
 * 幂等设计：只处理 city_id IS NULL 且 city != '' 的行
 */
async function migrateCityData(db: mysql.Pool) {
    // 1. 从 venue 表收集未迁移的城市名
    const [venueCities] = await db.execute(
        `SELECT DISTINCT city FROM venue WHERE city != '' AND city_id IS NULL`
    ) as any;

    // 2. 从 reservation 表收集未迁移的城市名
    const [resCities] = await db.execute(
        `SELECT DISTINCT city FROM reservation WHERE city != '' AND city_id IS NULL`
    ) as any;

    // 3. 合并去重，插入 city 表
    const allCityNames = new Set<string>();
    for (const r of venueCities) allCityNames.add(r.city);
    for (const r of resCities) allCityNames.add(r.city);

    if (allCityNames.size === 0) return; // 无需迁移

    if (allCityNames.size > 0) {
        const cityNames = Array.from(allCityNames);
        const values = cityNames.map((name) => [name]);
        await (db as any).query('INSERT IGNORE INTO city (name) VALUES ?', [values]);
    }

    // 4. 集合更新，避免按城市逐条回填
    await db.execute(
        `UPDATE venue v
         INNER JOIN city c ON c.name = v.city
         SET v.city_id = c.id
         WHERE v.city != '' AND v.city_id IS NULL`
    );

    // 5. 集合更新，避免按城市逐条回填
    await db.execute(
        `UPDATE reservation r
         INNER JOIN city c ON c.name = r.city
         SET r.city_id = c.id
         WHERE r.city != '' AND r.city_id IS NULL`
    );

    const migratedCount = venueCities.length + resCities.length;
    if (migratedCount > 0) {
        console.log(`🏙️ 城市迁移完成: ${allCityNames.size} 个城市, venue ${venueCities.length} 条 + reservation ${resCities.length} 条已回填 city_id`);
    }
}
