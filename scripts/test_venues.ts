import { getPool } from './src/db.js';
async function run() {
    const db = getPool();
    let sql = `SELECT id, name, city, cover_url as coverUrl, address, business_hours, phone, lat, lng
             FROM venue
             WHERE is_active=1`
    const [rows] = await db.execute(sql);
    console.log("venues:", rows);
    process.exit(0);
}
run();
