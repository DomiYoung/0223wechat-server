const mysql = require('mysql2/promise');
async function run() {
    const connection = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: '@Domi1688',
        database: 'wedding'
    });
    const [themes] = await connection.execute('SELECT id, title, case_type, style, tag, shop_label FROM wedding_case WHERE case_type="theme"');
    console.log('--- THEME INSPECTION ---');
    console.table(themes);
    await connection.end();
}
run();
