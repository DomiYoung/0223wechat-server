import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const DB_PORT = process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306;
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

async function run() {
    console.log('--- 开始合并/回滚批次对应的主题表数据 ---');

    // 找到所有新创建的 2026-04 的 cases
    const [newCases] = await pool.execute(`SELECT * FROM wedding_case WHERE batch_version = '2026-04'`) as any;
    console.log(`找到 ${newCases.length} 个新创建的 4月 主题.`);

    for (const nCase of newCases) {
        // 查找历史同门店、同名的老 case
        const [oldCases] = await pool.execute(
            `SELECT * FROM wedding_case WHERE venue_id = ? AND title = ? AND id != ? ORDER BY id ASC LIMIT 1`,
            [nCase.venue_id, nCase.title, nCase.id]
        ) as any;

        if (oldCases.length > 0) {
            const oldCase = oldCases[0];
            console.log(`[合并] 发现历史同名主题: ${oldCase.title} (老ID: ${oldCase.id} <- 新ID: ${nCase.id})`);

            // 1. 恢复老 Case 的状态并更新封面
            await pool.execute(
                `UPDATE wedding_case SET is_active = 1, cover_url = ? WHERE id = ?`,
                [nCase.cover_url || oldCase.cover_url, oldCase.id]
            );

            // 2. 将新产生的 4月 批次图片打上 batch_version 并转移到老 Case 上
        try {
            await pool.execute('ALTER TABLE case_image ADD COLUMN batch_version VARCHAR(50) NULL');
            console.log('  * 追加了 case_image.batch_version 字段以支持批次过滤.');
        } catch (e: any) {
             // 可能是列已经存在，吃掉错误
        }

        const [maxSortRows] = await pool.execute(
            `SELECT MAX(sort_order) as maxSort FROM case_image WHERE case_id = ?`,
            [oldCase.id]
        ) as any;
        const currentMax = maxSortRows[0].maxSort !== null ? maxSortRows[0].maxSort : -1;

        const [newImages] = await pool.execute(`SELECT id, sort_order FROM case_image WHERE case_id = ?`, [nCase.id]) as any;
        for (let i = 0; i < newImages.length; i++) {
            await pool.execute(
                `UPDATE case_image SET case_id = ?, sort_order = ?, batch_version = ? WHERE id = ?`,
                [oldCase.id, currentMax + 1 + i, nCase.batch_version, newImages[i].id]
            );
        }

            // 3. 删除新产生的那条空壳 Case
            await pool.execute(`DELETE FROM wedding_case WHERE id = ?`, [nCase.id]);
        }
    }

    // 同样也为套餐表包办做合并检查 (如果套餐表也产生了重复的 ID)
    const [newPackages] = await pool.execute(`SELECT * FROM package WHERE batch_version = '2026-04'`) as any;
    for (const nPkg of newPackages) {
        const [oldPackages] = await pool.execute(
            `SELECT * FROM package WHERE category_id = ? AND title = ? AND id != ? ORDER BY id ASC LIMIT 1`,
            [nPkg.category_id, nPkg.title, nPkg.id]
        ) as any;
        if (oldPackages.length > 0) {
            const oldPkg = oldPackages[0];
            console.log(`[合并] 发现历史同名套餐: ${oldPkg.title} (老ID: ${oldPkg.id} <- 新ID: ${nPkg.id})`);
            
            await pool.execute(`UPDATE package SET is_active = 1, cover_url = ? WHERE id = ?`, [nPkg.cover_url || oldPkg.cover_url, oldPkg.id]);
            
            const [maxSortRows] = await pool.execute(`SELECT MAX(sort_order) as maxSort FROM package_image WHERE package_id = ?`, [oldPkg.id]) as any;
            const currentMax = maxSortRows[0].maxSort !== null ? maxSortRows[0].maxSort : -1;
            
            const [newImages] = await pool.execute(`SELECT id, sort_order FROM package_image WHERE package_id = ?`, [nPkg.id]) as any;
            for (let i = 0; i < newImages.length; i++) {
                await pool.execute(`UPDATE package_image SET package_id = ?, sort_order = ? WHERE id = ?`, [oldPkg.id, currentMax + 1 + i, newImages[i].id]);
            }
            await pool.execute(`DELETE FROM package WHERE id = ?`, [nPkg.id]);
        }
    }

    console.log('--- 数据洗版合并完毕，无冗余数据 ---');
    process.exit(0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
