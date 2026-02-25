# 0223 非 original 代码审查报告

> 审查日期：2025-02-25
> 基线来源：`0223wechat-original/app-service.js` + `scripts/shop.json`
> 审查对象：`0223wechat-server` / `0223wechat-admin` / `0223wechat`

---

## 一、Original 契约基线 (Schema Contract)

### 1.1 shop.json 结构

```typescript
interface OriginalShopData {
  sh: ThemeItem[];  // 上海
  bj: ThemeItem[];  // 北京
  nj: ThemeItem[];  // 南京
}

interface ThemeItem {
  index: string;    // 店铺标识（如"海岛婚礼店"、"空中花园店"、"国展店"）
  title: string;    // 主题名称（如"慕夏花园"、"莫奈花园"）
  url: string;      // 跳转链接（pages/index/main?store_url=...）
  img: string;      // 封面图文件名（如 muxiahuayuan_cover.jpg）
  subPage: SubPageItem[];  // 详情图列表
}

interface SubPageItem {
  url: string;      // 完整图片 URL（https://photos.huajialishe.cn/...）
}
```

### 1.2 关键语义定义

| 字段 | 语义 | 必填 | 示例 |
|------|------|------|------|
| `index` | **店铺标识**（同城市下可有多个店铺，每个店铺下有多个主题） | ✅ | `海岛婚礼店`、`黄兴公园店`、`江景店` |
| `title` | 主题名称 | ✅ | `慕夏花园`、`莫奈花园`、`小王子与玫瑰` |
| `url` | 跳转链接（含 store_url 参数） | ✅ | `pages/index/main?store_url=https://...` |
| `img` | 封面图（文件名，需拼接基础路径） | ✅ | `monet_cover.jpg` |
| `subPage` | 详情图数组，每项含 `url` 字段 | ✅ | `[{url: "https://...jpg"}]` |

### 1.3 城市分布统计（shop.json 样本）

| 城市 | 主题数 | 店铺标识 |
|------|--------|----------|
| sh (上海) | 9 | 海岛婚礼店(4)、黄兴公园店(2)、江景店(3) |
| bj (北京) | 16 | 海岛婚礼店(7)、空中花园店(8)、海岛婚礼店(1) |
| nj (南京) | 6 | 国展店(6) |

---

## 二、Server 审查 (`/api/themes` 兼容层)

### 2.1 当前实现分析

**文件**: `@/Users/jinjia/projects/代码项目/0223wechat-server/src/index.ts:472-510`

```typescript
app.get('/api/themes', async (c) => {
    const [venues] = await pool.execute(
        'SELECT id, name, city FROM venue WHERE is_active = 1 ORDER BY city, id'
    );
    const result: Record<string, any[]> = {};
    const cityMap: Record<string, string> = { '上海': 'sh', '北京': 'bj', '南京': 'nj' };

    for (const venue of venues) {
        const cityKey = cityMap[venue.city] || venue.city;
        const [themes] = await pool.execute(...);
        for (const theme of themes) {
            result[cityKey].push({
                index: venue.name,      // ⚠️ 问题：用门店名替代店铺标识
                title: theme.title,
                img: theme.cover_url,   // ✅ 正确
                subPage: ...,           // ✅ 正确
                // ❌ 缺失 url 字段
            });
        }
    }
});
```

### 2.2 问题清单

| # | 级别 | 问题 | 证据 | 影响 |
|---|------|------|------|------|
| S1 | **P0** | `url` 字段完全缺失 | 输出结构无 `url` 键 | 小程序跳转逻辑可能失效 |
| S2 | **P1** | `index` 语义漂移 | 使用 `venue.name`（门店名）替代 original 的**店铺标识**（如"海岛婚礼店"） | 同城市多门店时分组错误 |
| S3 | **P1** | `img` 格式不一致 | original 为文件名，server 输出完整 URL | 若前端拼接基础路径会导致双重前缀 |
| S4 | **P2** | N+1 查询性能问题 | 每个 venue 单独查询 themes | 数据量大时响应慢 |

### 2.3 建议修复方案

```typescript
// 修复 S1: 添加 url 字段（从 wedding_case 新增字段或使用默认模板）
// 修复 S2: 使用 wedding_case.style 或 shop_label 作为 index
// 修复 S3: 保持 original 契约，输出文件名，前端负责拼接
```

---

## 三、DB 设计审查

### 3.1 表结构分析

**文件**: `@/Users/jinjia/projects/代码项目/0223wechat-server/src/db.ts:67-90`

```sql
CREATE TABLE wedding_case (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(100) NOT NULL,        -- ✅ 对应 original.title
    tag VARCHAR(50) DEFAULT '',         -- ❓ 无 original 对应
    style VARCHAR(50) DEFAULT '',       -- ⚠️ 被 seed 用作店铺标识
    wedding_date VARCHAR(50) DEFAULT '',-- ❓ 无 original 对应
    shop_label VARCHAR(50) DEFAULT '',  -- ⚠️ 被 seed 用作城市标签
    description TEXT,                   -- ❓ 无 original 对应
    cover_url TEXT,                     -- ✅ 对应 original.img (已转完整URL)
    venue_id INT DEFAULT NULL,          -- 🔗 关联门店（新增维度）
    ...
);
```

### 3.2 语义映射矩阵

| Original 字段 | DB 字段 | Seed 写入逻辑 | Server 读取逻辑 | 一致性 |
|---------------|---------|---------------|-----------------|--------|
| `index` (店铺标识) | `style` | ✅ 写入店铺标识 | ❌ 未读取，改用 venue.name | **断裂** |
| `title` | `title` | ✅ | ✅ | ✅ |
| `url` | 无字段 | ❌ 未存储 | ❌ 未输出 | **缺失** |
| `img` | `cover_url` | ✅ 转换为 OSS URL | ✅ 但格式变化 | ⚠️ 格式变化 |
| `subPage` | `case_image` | ✅ 逐条存储 | ✅ 正确聚合 | ✅ |
| 城市码 | `venue.city` + `shop_label` | ✅ | ✅ cityMap 转换 | ✅ |

### 3.3 问题清单

| # | 级别 | 问题 | 证据 | 影响 |
|---|------|------|------|------|
| D1 | **P0** | 无 `url` 字段 | `wedding_case` 表无 url 列 | original 契约不可完整还原 |
| D2 | **P1** | `style` 语义重载 | seed 写入店铺标识，admin UI 显示为"风格" | 维护人员认知错位 |
| D3 | **P1** | `shop_label` 语义模糊 | seed 写入城市名（上海/北京/南京），admin 显示为"原始标识" | 语义漂移 |
| D4 | **P2** | 缺少唯一约束 | `title + venue_id` 应为唯一键但仅靠代码保证 | 可能出现重复数据 |

---

## 四、Admin 审查

### 4.1 字段展示与语义

**文件**: `@/Users/jinjia/projects/代码项目/0223wechat-admin/src/pages/Cases.tsx:45-61`

```typescript
interface ThemeItem {
    style: string;        // UI 显示为"展厅/风格"
    shop_label: string;   // UI 显示为"原始标识"（斜体灰字）
    venue_name?: string;  // UI 显示为"隶属门店"
    ...
}
```

### 4.2 UI 文案与 Original 语义对照

| Admin 表头 | 实际字段 | Original 对应 | 问题 |
|------------|----------|---------------|------|
| "展厅/风格" | `style` | `index` (店铺标识) | ❌ 文案误导，用户以为是"风格"而非"店铺" |
| "原始标识" | `shop_label` | 城市名 | ⚠️ 文案模糊，实际是城市不是标识 |
| "隶属门店" | `venue_name` | 无直接对应 | ✅ 新增维度，无冲突 |

### 4.3 问题清单

| # | 级别 | 问题 | 证据 | 影响 |
|---|------|------|------|------|
| A1 | **P1** | "展厅/风格"文案误导 | 表头写"风格"，实际存储店铺标识 | 编辑时认知错位 |
| A2 | **P2** | "原始标识"语义不清 | 显示城市名，文案却叫"标识" | 理解成本高 |
| A3 | **P2** | 缺少 url 编辑入口 | 表单无 url 字段 | 无法维护跳转链接 |

---

## 五、Seed 脚本审查

### 5.1 映射逻辑分析

**文件**: `@/Users/jinjia/projects/代码项目/0223wechat-server/scripts/seed_original_themes.cjs:81-113`

```javascript
// 清洗店名逻辑
let storeIndex = item.index || '';
if (storeIndex.includes('海') && storeIndex.includes('婚礼店')) storeIndex = '海岛婚礼店';
else if (storeIndex.includes('空') && storeIndex.includes('花园店')) storeIndex = '空中花园店';
else if (storeIndex.includes('国展')) storeIndex = '国展店';
else if (storeIndex.includes('外滩')) storeIndex = '外滩店';

// 写入数据库
await db.execute(
    `INSERT INTO wedding_case (title, style, cover_url, venue_id, is_active, sort_order, shop_label)
     VALUES (?, ?, ?, ?, 1, 0, ?)`,
    [item.title, storeIndex, coverUrl, venueId, shopLabel]  // style=店铺标识, shop_label=城市
);
```

### 5.2 问题清单

| # | 级别 | 问题 | 证据 | 影响 |
|---|------|------|------|------|
| E1 | **P1** | 字段语义交叉 | `style` 存店铺标识，`shop_label` 存城市 | 与字段名语义不符 |
| E2 | **P2** | 清洗规则不完整 | 只处理 4 种店铺，其他直接透传 | 未知店铺可能异常 |
| E3 | ✅ | 增量同步已实现 | 使用 `title + venue_id` 去重 | 符合你的要求 |
| E4 | ✅ | 图片去重已实现 | `case_id + image_url` 去重 | 符合你的要求 |

---

## 六、四层一致性矩阵

| Original 字段 | DB (wedding_case) | Seed 写入 | Server 读取 | Admin 展示 | 一致性 |
|---------------|-------------------|-----------|-------------|------------|--------|
| `index` (店铺标识) | `style` | ✅ 清洗后写入 | ❌ 用 venue.name 替代 | "展厅/风格" | **❌ 断裂** |
| `title` | `title` | ✅ | ✅ | "主题名称" | ✅ |
| `url` | **无字段** | ❌ 未存储 | ❌ 未输出 | 无入口 | **❌ 完全缺失** |
| `img` | `cover_url` | ✅ 转 OSS URL | ✅ | "封面" | ⚠️ 格式变化 |
| `subPage[]` | `case_image` | ✅ | ✅ 聚合输出 | "详情图" | ✅ |
| 城市码 (sh/bj/nj) | `venue.city` | ✅ | ✅ cityMap 转换 | 城市筛选 | ✅ |

---

## 七、问题分级与修复优先级

### P0 - 契约破坏（必须修复）

| ID | 问题 | 修复方案 | 涉及文件 |
|----|------|----------|----------|
| S1 | `/api/themes` 缺失 `url` 字段 | 1) 新增 DB 字段 `theme_url`<br>2) seed 脚本写入<br>3) API 输出 | `db.ts`, `seed_original_themes.cjs`, `index.ts` |
| D1 | DB 无 url 字段 | `ALTER TABLE wedding_case ADD COLUMN theme_url TEXT AFTER cover_url` | `db.ts` |

### P1 - 语义漂移（建议修复）

| ID | 问题 | 修复方案 | 涉及文件 |
|----|------|----------|----------|
| S2 | `index` 用 venue.name 替代 | 改为读取 `wedding_case.style` | `index.ts` |
| S3 | `img` 格式变化 | 保持完整 URL（前端已适配）或提供选项 | 评估后决定 |
| D2 | `style` 语义重载 | 考虑新增 `store_label` 字段，迁移数据 | `db.ts`, `seed_original_themes.cjs` |
| D3 | `shop_label` 语义模糊 | 重命名为 `city_label` 或合并到 venue 维度 | `db.ts` |
| E1 | 字段语义交叉 | 统一命名策略 | `seed_original_themes.cjs` |
| A1 | "展厅/风格"文案误导 | 改为"店铺标识" | `Cases.tsx` |

### P2 - 体验/文案偏差（可选修复）

| ID | 问题 | 修复方案 | 涉及文件 |
|----|------|----------|----------|
| S4 | N+1 查询 | 改为单次 JOIN 查询 | `index.ts` |
| D4 | 缺少唯一约束 | `ALTER TABLE ADD UNIQUE (title, venue_id)` | `db.ts` |
| E2 | 清洗规则不完整 | 扩展店铺映射表 | `seed_original_themes.cjs` |
| A2 | "原始标识"语义不清 | 改为"城市"或移除 | `Cases.tsx` |
| A3 | 缺少 url 编辑 | 表单新增 url 输入框 | `Cases.tsx` |

---

## 八、建议修复顺序

### 批次 1：修复 P0（契约破坏）
1. `db.ts` - 新增 `theme_url` 字段
2. `seed_original_themes.cjs` - 写入 url 数据
3. `index.ts` - `/api/themes` 输出 url 字段
4. 验证：对比 original shop.json 与 `/api/themes` 输出

### 批次 2：修复 P1（语义漂移）
1. `index.ts` - `index` 改为读取 `style` 而非 `venue.name`
2. `Cases.tsx` - 修正表头文案
3. 可选：字段重命名（需数据迁移）

### 批次 3：修复 P2（体验优化）
1. 性能优化：N+1 → JOIN
2. Admin 完善：url 编辑入口
3. 约束强化：唯一索引

---

## 九、验证方案

### A. 接口级验证（契约一致）

```bash
# 获取 original 基线
curl -s https://api.huajialishe.com/constant/json/wx-miniprogram/shop.json > /tmp/original.json

# 获取 non-original 输出
curl -s http://localhost:3000/api/themes > /tmp/server.json

# 对比结构
jq 'keys' /tmp/original.json  # 期望: ["bj", "nj", "sh"]
jq 'keys' /tmp/server.json    # 期望: ["bj", "nj", "sh"]

# 检查字段完整性
jq '.sh[0] | keys' /tmp/original.json  # 期望: ["img", "index", "subPage", "title", "url"]
jq '.sh[0] | keys' /tmp/server.json    # 当前: ["img", "index", "subPage", "title"] ← 缺 url
```

### B. 数据级验证（映射可逆）

```sql
-- 抽样验证：上海「慕夏花园」
SELECT
    wc.title,
    wc.style AS store_index,
    wc.shop_label AS city_label,
    wc.cover_url,
    GROUP_CONCAT(ci.image_url ORDER BY ci.sort_order) AS images
FROM wedding_case wc
LEFT JOIN case_image ci ON ci.case_id = wc.id
WHERE wc.title = '慕夏花园'
GROUP BY wc.id;
```

### C. 页面级验证（Admin 闭环）

1. 登录 Admin 后台
2. 编辑一条主题，修改 style 字段
3. 调用 `/api/themes`，确认 `index` 字段反映修改
4. 验证 `subPage` 图片排序与 DB 一致

---

## 十、结论

| 维度 | 状态 | 说明 |
|------|------|------|
| 契约完整性 | ❌ | `url` 字段完全缺失 |
| 语义一致性 | ⚠️ | `index` / `style` / `shop_label` 语义漂移 |
| 数据可逆性 | ⚠️ | 除 url 外基本可逆 |
| 增量同步 | ✅ | seed 脚本已实现增量 UPSERT |
| 图片去重 | ✅ | seed 脚本已实现 |
| Admin 可维护 | ⚠️ | 文案误导，缺少 url 编辑 |

**建议**：先执行 P0 修复（url 字段），再逐步处理 P1/P2。本轮审查不改代码，待你确认后进入修复执行。

---

## 附录：脚本与 SQL 质量审查

### A. 脚本增量同步状态

| 脚本 | 增量策略 | OSS 去重 | 状态 |
|------|----------|----------|------|
| `seed_original_themes.cjs` | ✅ `title + venue_id` UPSERT | N/A | ✅ 符合要求 |
| `migrate_assets_to_oss.cjs` | ✅ Map 去重 | ✅ `client.head()` 跳过已存在 | ✅ 符合要求 |
| `cleanup_db.cjs` | N/A（清理用） | N/A | ✅ 安全模式，不 TRUNCATE |
| `update_db.js` | ✅ `ER_DUP_FIELDNAME` 幂等 | N/A | ✅ 可重复执行 |

### B. SQL 质量评估

#### 优点
- 表结构使用 `IF NOT EXISTS`，幂等创建 ✅
- 外键设置 `ON DELETE CASCADE`/`SET NULL`，自动清理孤立数据 ✅
- 索引覆盖主要查询路径（`idx_venue_active`、`idx_featured`、`idx_sort`）✅
- 字符集统一 `utf8mb4`，支持 emoji ✅

#### 待改进
| # | 问题 | 建议 |
|---|------|------|
| Q1 | `wedding_case` 缺少 `(title, venue_id)` 唯一约束 | 添加 `UNIQUE INDEX` 防止重复 |
| Q2 | `admin.password_hash` 明文存储 | 迁移到 bcrypt 哈希 |
| Q3 | `/api/themes` 存在 N+1 查询 | 改为单次 JOIN + GROUP_CONCAT |
| Q4 | `case_image.image_url` 无长度限制（TEXT） | 考虑改为 `VARCHAR(500)` + 索引 |
| Q5 | 无 `created_at/updated_at` 默认索引 | 按需添加时间范围查询索引 |

### C. 建议执行的 DDL（可选）

```sql
-- Q1: 添加唯一约束
ALTER TABLE wedding_case ADD UNIQUE INDEX uk_title_venue (title, venue_id);

-- Q4: 优化图片 URL 字段（需先验证最大长度）
-- ALTER TABLE case_image MODIFY image_url VARCHAR(500) NOT NULL;
```

### D. 脚本安全检查

| 检查项 | 状态 |
|--------|------|
| 无硬编码密码 | ✅ 使用 `.env` |
| SQL 参数化 | ✅ 使用 `?` 占位符 |
| 无 TRUNCATE/DROP | ✅ 仅 cleanup 有条件删除 |
| 错误处理 | ✅ try/catch + 日志 |

---

## 附录 E：小程序端审查（关键发现）

### E.1 核心发现：小程序未使用 `/api/themes` 契约接口

**证据**：全局搜索 `/api/themes` 和 `shop.json` 均无命中。

小程序实际使用的 API：

| 页面 | 调用接口 | 数据结构 |
|------|----------|----------|
| `home/home.js` | `/api/venues?city=上海` | 门店列表（非主题） |
| `live/live.js` | `/api/cases/live` | 案例瀑布流 |
| `details/details.js` | `/api/cases/:id` | 单个案例详情 |
| `venue/venue.js` | `/api/venues` | 门店详情 |

### E.2 契约断裂分析

```
Original 架构（shop.json 契约）:
  小程序 → 直接读取 shop.json → 按城市+店铺分组的主题列表

当前架构（已改造）:
  小程序 → /api/venues（门店）+ /api/cases（案例）→ 分离的两个维度

兼容层（未被消费）:
  /api/themes → 输出 shop.json 格式 → 但小程序不调用
```

### E.3 影响评估

| 问题 | 级别 | 说明 |
|------|------|------|
| `/api/themes` 是死接口 | **P1** | 小程序不消费，但 seed 脚本在维护 |
| original 契约已废弃 | **P1** | 小程序已改造为 venues + cases 分离模式 |
| `index`（店铺标识）语义丢失 | **P2** | 新架构用 `venue.name` 替代 |
| `url` 字段完全无用 | **P0→降级** | 小程序不跳转 store_url，不需要此字段 |

### E.4 小程序字段依赖（实际消费）

**home.js** 依赖 `/api/venues` 返回字段：
```javascript
// 文件: @/Users/jinjia/projects/代码项目/0223wechat/pages/home/home.js:48-52
request({ url: `/api/venues?city=${encodeURIComponent(cityName)}` })
    .then(res => {
        shop[cityCode] = res || [];  // 直接使用 venue 列表
    })
```

**details.js** 依赖 `/api/cases/:id` 返回字段：
```javascript
// 文件: @/Users/jinjia/projects/代码项目/0223wechat/pages/details/details.js:33-35
if (res && res.images) {
    const mappedImgs = res.images.map(img => ({ url: img.image_url }));
    this.setData({ subPage: mappedImgs });  // 需要 subPage 格式
}
```

**live.js** 依赖 `/api/cases/live` 返回字段：
```javascript
// 文件: @/Users/jinjia/projects/代码项目/0223wechat/pages/live/live.js:14-16
request({ url: '/api/cases/live' })
    .then(res => {
        this.setData({ masonry: res });  // 瀑布流数据
    })
```

### E.5 结论与建议

| 选项 | 描述 | 风险 |
|------|------|------|
| **A. 保留 `/api/themes` 作为备份** | 不改小程序，themes 接口仅供参考/迁移 | 维护成本 |
| **B. 删除 `/api/themes`** | 小程序不用，简化代码 | 未来若需兼容 original 需重建 |
| **C. 改造小程序回归 original** | 让小程序消费 `/api/themes` | 改动大，需评估收益 |

**建议**：选择 A 或 B。当前小程序已稳定运行，无需回归 original 契约。

---

## 附录 F：数据库设计深度审查

### F.1 表结构矩阵

| 表 | 主键 | 唯一约束 | 外键 | 问题 |
|----|------|----------|------|------|
| `admin` | id | username | - | ⚠️ password_hash 存明文 |
| `config` | id | config_key | - | ✅ |
| `venue` | id | 无 | - | ⚠️ name+city 应加唯一约束 |
| `wedding_case` | id | 无 | venue_id→venue | ❌ 缺 (title,venue_id) 唯一约束 |
| `case_image` | id | 无 | case_id→wedding_case | ⚠️ 缺 (case_id,image_url) 唯一约束 |
| `reservation` | id | 无 | venue_id,case_id | ✅ 业务允许重复预约 |
| `audit_log` | id | 无 | 无(admin_id 无FK) | ⚠️ 可选加 FK |

### F.2 外键关系图

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   venue     │◄────│wedding_case │────►│case_image   │
│   (门店)    │ 1:N │  (主题)     │ 1:N │  (图片)     │
│             │     │             │     │ CASCADE     │
└──────┬──────┘     └──────┬──────┘     └─────────────┘
       │ SET NULL          │ SET NULL
       ▼                   ▼
┌─────────────────────────────────────────────────────┐
│                   reservation (客资预约)             │
└─────────────────────────────────────────────────────┘
```

### F.3 索引覆盖分析

| 查询场景 | 索引 | 覆盖情况 |
|----------|------|----------|
| 按门店查主题 | `idx_venue_active(venue_id, is_active)` | ✅ |
| 推荐主题 | `idx_featured(is_featured, is_active)` | ✅ |
| 排序分页 | `idx_sort_id(sort_order, id)` | ✅ |
| 搜索主题 | `idx_title(title(50))` | ⚠️ 前缀%无法用索引 |
| 图片列表 | `idx_case_sort(case_id, sort_order)` | ✅ |
| 预约状态筛选 | `idx_status_created(status, created_at)` | ✅ |

### F.4 建议执行的 DDL

```sql
-- P1: 唯一约束
ALTER TABLE wedding_case ADD UNIQUE INDEX uk_title_venue (title, venue_id);
ALTER TABLE case_image ADD UNIQUE INDEX uk_case_url (case_id, image_url(255));
ALTER TABLE venue ADD UNIQUE INDEX uk_name_city (name, city);

-- P2: 字段优化
ALTER TABLE wedding_case MODIFY cover_url VARCHAR(500) DEFAULT '';
ALTER TABLE case_image MODIFY image_url VARCHAR(500) NOT NULL;
```
