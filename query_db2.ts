import { getPool } from './src/db.js';
async function run() {
    const db = getPool();
    try {
        const [rows] = await db.execute("DESCRIBE wedding_case");
        console.log("wedding_case schema:", JSON.stringify(rows, null, 2));
    } catch(e) {
        console.error(e);
    }
    process.exit(0);
}
run();
