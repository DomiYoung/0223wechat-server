const { getConnection } = require('./_db.cjs');
async function run() {
    const db = await getConnection();
    const [vars] = await db.execute('SHOW VARIABLES LIKE "character_set_%"');
    console.log('Database Character Sets:');
    console.table(vars);

    const [cols] = await db.execute('SHOW FULL COLUMNS FROM wedding_case');
    console.log('Table Columns Collation:');
    console.table(cols.map(c => ({ Field: c.Field, Collation: c.Collation })));

    const [samples] = await db.execute('SELECT id, title, style, shop_label FROM wedding_case LIMIT 5');
    console.log('Theme Samples:');
    console.table(samples);

    await db.end();
}
run().catch(console.error);
