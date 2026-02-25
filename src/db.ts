import 'dotenv/config';
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wedding_cms',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
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
            password_hash VARCHAR(255) NOT NULL COMMENT '密码(待迁移bcrypt)',
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

    // 8. audit_log — 操作审计日志
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
    // 数据迁移：从 venue/reservation 的 city 文本迁移到 city 表
    // ============================================================
    await migrateCityData(db);

    // ============================================================
    // 种子数据（仅首次启动时填充）
    // ============================================================
    const [adminRows] = await db.execute('SELECT COUNT(*) as count FROM admin') as any;
    if (adminRows[0].count === 0) {
        await db.execute(
            'INSERT INTO admin (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
            ['admin', 'wedding2024', '超级管理员', 'super']
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

    console.log('✅ 数据库初始化完毕 — 8张表全部就绪');
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

    for (const name of allCityNames) {
        await db.execute('INSERT IGNORE INTO city (name) VALUES (?)', [name]);
    }

    // 4. 读取完整城市映射
    const [cityRows] = await db.execute('SELECT id, name FROM city') as any;
    const cityMap = new Map(cityRows.map((r: any) => [r.name, r.id]));

    // 5. 回填 venue.city_id
    for (const [name, id] of cityMap) {
        await (db as any).execute(
            'UPDATE venue SET city_id = ? WHERE city = ? AND city_id IS NULL',
            [id, name]
        );
    }

    // 6. 回填 reservation.city_id
    for (const [name, id] of cityMap) {
        await (db as any).execute(
            'UPDATE reservation SET city_id = ? WHERE city = ? AND city_id IS NULL',
            [id, name]
        );
    }

    const migratedCount = venueCities.length + resCities.length;
    if (migratedCount > 0) {
        console.log(`🏙️ 城市迁移完成: ${allCityNames.size} 个城市, venue ${venueCities.length} 条 + reservation ${resCities.length} 条已回填 city_id`);
    }
}
