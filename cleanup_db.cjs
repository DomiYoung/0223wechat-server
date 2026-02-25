const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

async function cleanup() {
    const db = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: '@Domi1688',
        database: 'wedding'
    });

    console.log('Cleaning up database...');

    // 禁用外键检查（如果有的话）
    await db.execute('SET FOREIGN_KEY_CHECKS = 0');

    console.log('Truncating case_image...');
    await db.execute('TRUNCATE TABLE case_image');

    console.log('Truncating wedding_case...');
    await db.execute('TRUNCATE TABLE wedding_case');

    await db.execute('SET FOREIGN_KEY_CHECKS = 1');

    console.log('Cleanup complete!');
    await db.end();
}

cleanup().catch(console.error);
