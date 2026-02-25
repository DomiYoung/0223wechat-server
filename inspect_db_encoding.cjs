const mysql = require('mysql2/promise');
async function run() {
    const db = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: '@Domi1688',
        database: 'wedding'
    });
    const [vars] = await db.execute('SHOW VARIABLES LIKE "character_set_%"');
    console.log('Database Character Sets:');
    console.table(vars);
    
    const [cols] = await db.execute('SHOW FULL COLUMNS FROM wedding_case');
    console.log('Table Columns Collation:');
    console.table(cols.map(c => ({Field: c.Field, Collation: c.Collation})));
    
    const [samples] = await db.execute('SELECT id, title, style, shop_label FROM wedding_case WHERE case_type="theme" LIMIT 5');
    console.log('Theme Samples (Style Field):');
    console.table(samples);
    
    await db.end();
}
run().catch(console.error);
