const { getConnection } = require('./_db.cjs');
async function run() {
    const db = await getConnection();
    const [bjThemes] = await db.execute(
        'SELECT id, title, style FROM wedding_case WHERE shop_label = ?',
        ['北京']
    );
    console.log('Beijing Themes Styles:');
    console.table(bjThemes);
    await db.end();
}
run().catch(console.error);
