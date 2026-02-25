const mysql = require('mysql2/promise');
require('dotenv').config();
async function main() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'wedding'
    });
    const sql = "ALTER TABLE wedding_case ADD COLUMN wedding_date VARCHAR(50) DEFAULT '' COMMENT '婚礼真实日期 (如 2019.7.7)' AFTER style, ADD COLUMN shop_label VARCHAR(50) DEFAULT '' COMMENT '原版店名标识 (如 北京店探店)' AFTER wedding_date, ADD COLUMN description TEXT COMMENT '婚礼好评文案/长描述' AFTER shop_label;";
    try {
        await conn.execute(sql);
        console.log("字段追加成功");
    } catch (err) {
        if(err.code === 'ER_DUP_FIELDNAME') {
            console.log("字段已经存在，跳过");
        } else {
            console.error(err);
        }
    }
    await conn.end();
}
main();
