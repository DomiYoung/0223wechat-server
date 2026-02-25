const mysql = require('mysql2/promise');
async function run() {
    const connection = await mysql.createConnection({
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '@Domi1688',
        database: 'wedding'
    });
    console.log('\n--- CITY TYPE AUDIT START ---');

    const [stats] = await connection.execute(`
    SELECT 
        v.city as venue_city, 
        wc.case_type, 
        COUNT(*) as count 
    FROM wedding_case wc 
    LEFT JOIN venue v ON wc.venue_id = v.id 
    GROUP BY v.city, wc.case_type
  `);
    console.log('\n[Case Type Breakdown by City]');
    console.table(stats);

    const [shThemes] = await connection.execute('SELECT id, title, style, shop_label FROM wedding_case WHERE case_type="theme" AND (shop_label LIKE "%上海%" OR shop_label="")');
    console.log('\n[Shanghai Theme Samples]');
    console.table(shThemes);

    const [bjCases] = await connection.execute('SELECT id, title, style, shop_label FROM wedding_case WHERE case_type="case" AND shop_label LIKE "%北京%" LIMIT 5');
    console.log('\n[Beijing Case Samples]');
    console.table(bjCases);

    console.log('\n--- CITY TYPE AUDIT END ---');
    await connection.end();
}
run().catch(console.error);
