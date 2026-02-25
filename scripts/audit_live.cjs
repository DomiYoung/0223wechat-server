const { getConnection } = require('./_db.cjs');
async function run() {
    const db = await getConnection();
    console.log('\n--- CITY TYPE AUDIT START ---');

    const [stats] = await db.execute(`
        SELECT v.city as venue_city, COUNT(*) as count
        FROM wedding_case wc
        LEFT JOIN venue v ON wc.venue_id = v.id
        GROUP BY v.city
    `);
    console.log('\n[Theme Breakdown by City]');
    console.table(stats);

    const [shThemes] = await db.execute(
        'SELECT id, title, style, shop_label FROM wedding_case WHERE shop_label LIKE ? LIMIT 10',
        ['%上海%']
    );
    console.log('\n[Shanghai Theme Samples]');
    console.table(shThemes);

    const [bjCases] = await db.execute(
        'SELECT id, title, style, shop_label FROM wedding_case WHERE shop_label LIKE ? LIMIT 5',
        ['%北京%']
    );
    console.log('\n[Beijing Case Samples]');
    console.table(bjCases);

    console.log('\n--- CITY TYPE AUDIT END ---');
    await db.end();
}
run().catch(console.error);
