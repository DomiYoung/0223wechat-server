const mysql = require('mysql2/promise');
async function run() {
    const db = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: '@Domi1688',
        database: 'wedding'
    });
    const [njThemes] = await db.execute('SELECT id, title, cover_url, style FROM wedding_case WHERE shop_label="南京"');
    console.log('Nanjing Themes:');
    console.table(njThemes);
    
    // Check if these images are accessible (optional, just listing for now)
    await db.end();
}
run().catch(console.error);
