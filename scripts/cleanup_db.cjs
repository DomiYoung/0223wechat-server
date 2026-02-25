/**
 * 数据库清理工具 — 安全模式
 *
 * 功能：
 *   - 清理孤立图片（case_id 对应的主题已删除）
 *   - 清理无图片的空主题
 *   - 统计各表数据量
 *
 * ⚠️ 不再使用 TRUNCATE，仅清理无效数据
 * 运行：node scripts/cleanup_db.cjs
 */
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function cleanup() {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'wedding_cms',
    });

    console.log('🔍 数据库健康检查...\n');

    // 1. 统计各表数据量
    const tables = ['admin', 'venue', 'wedding_case', 'case_image', 'reservation', 'audit_log'];
    for (const table of tables) {
        const [rows] = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
        console.log(`   ${table}: ${rows[0].c} 条`);
    }

    // 2. 清理孤立图片（外键 CASCADE 应已处理，这是兜底）
    const [orphanImages] = await db.execute(
        `SELECT ci.id FROM case_image ci
         LEFT JOIN wedding_case wc ON ci.case_id = wc.id
         WHERE wc.id IS NULL`
    );
    if (orphanImages.length > 0) {
        await db.execute(
            `DELETE ci FROM case_image ci
             LEFT JOIN wedding_case wc ON ci.case_id = wc.id
             WHERE wc.id IS NULL`
        );
        console.log(`\n🧹 清理了 ${orphanImages.length} 条孤立图片`);
    }

    // 3. 查找重复主题（相同 title + venue_id）
    const [dupes] = await db.execute(
        `SELECT title, venue_id, COUNT(*) as cnt
         FROM wedding_case
         GROUP BY title, venue_id
         HAVING cnt > 1`
    );
    if (dupes.length > 0) {
        console.log(`\n⚠️ 发现 ${dupes.length} 组重复主题:`);
        for (const d of dupes) {
            console.log(`   "${d.title}" (venue_id=${d.venue_id}) × ${d.cnt}`);
            // 保留最新一条，删除旧的
            const [rows] = await db.execute(
                `SELECT id FROM wedding_case WHERE title = ? AND venue_id = ? ORDER BY id DESC`,
                [d.title, d.venue_id]
            );
            const keepId = rows[0].id;
            const deleteIds = rows.slice(1).map(r => r.id);
            if (deleteIds.length > 0) {
                const placeholders = deleteIds.map(() => '?').join(',');
                await db.execute(`DELETE FROM wedding_case WHERE id IN (${placeholders})`, deleteIds);
                console.log(`   → 保留 id=${keepId}，删除 ${deleteIds.join(',')}`);
            }
        }
    }

    console.log('\n✅ 清理完成');
    await db.end();
}

cleanup().catch(console.error);
