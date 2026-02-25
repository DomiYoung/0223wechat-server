import { getPool } from './src/db.js';
async function run() {
    const db = getPool();
    try {
        const [rows] = await db.execute("SELECT * FROM wedding_case LIMIT 5");
        console.log("wedding_case rows:", JSON.stringify(rows, null, 2));
    } catch(e) {
        console.error(e);
    }
    process.exit(0);
}
run();
