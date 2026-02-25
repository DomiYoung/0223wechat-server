const { getConnection } = require('./_db.cjs');
async function run() {
    const db = await getConnection();
    const [njThemes] = await db.execute(
        'SELECT id, title, cover_url, style FROM wedding_case WHERE shop_label = ?',
        ['南京']
    );
    console.log('Nanjing Themes:');
    console.table(njThemes);
    await db.end();
}
run().catch(console.error);
