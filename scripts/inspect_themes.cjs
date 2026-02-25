const { getConnection } = require('./_db.cjs');
async function run() {
    const db = await getConnection();
    const [themes] = await db.execute(
        'SELECT id, title, style, tag, shop_label FROM wedding_case'
    );
    console.log('--- THEME INSPECTION ---');
    console.table(themes);
    await db.end();
}
run().catch(console.error);
