import { getPool } from './src/db.js';

async function audit() {
    const db = getPool();
    try {
        console.log('--- Venue Counts ---');
        const [venues] = await db.execute('SELECT city, COUNT(*) as count FROM venue GROUP BY city');
        console.table(venues);

        console.log('--- Wedding Case shop_label Analysis ---');
        const [labels] = await db.execute('SELECT shop_label, COUNT(*) as count FROM wedding_case GROUP BY shop_label');
        console.table(labels);

        console.log('--- Linked Cases Count ---');
        const [linked] = await db.execute('SELECT v.city, COUNT(*) as count FROM wedding_case wc JOIN venue v ON wc.venue_id = v.id GROUP BY v.city');
        console.table(linked);

        console.log('--- Image Presence ---');
        const [images] = await db.execute('SELECT COUNT(*) as total_images FROM case_image');
        console.table(images);

        const [sampleImages] = await db.execute('SELECT case_id, COUNT(*) FROM case_image GROUP BY case_id LIMIT 5');
        console.table(sampleImages);

    } catch (err) {
        console.error(err);
    } finally {
        process.exit(0);
    }
}

audit();
