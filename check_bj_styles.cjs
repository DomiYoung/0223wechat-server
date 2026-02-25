const mysql = require('mysql2/promise');
async function run() {
    const db = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: '@Domi1688',
        database: 'wedding'
    });
    const [bjThemes] = await db.execute('SELECT id, title, style FROM wedding_case WHERE shop_label="北京" AND case_type="theme"');
    console.log('Beijing Themes Styles:');
    console.table(bjThemes);
    await db.end();
}
run().catch(console.error);
