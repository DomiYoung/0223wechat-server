const { getConnection } = require('./_db.cjs');
async function main() {
    const db = await getConnection();
    const sql = "ALTER TABLE wedding_case ADD COLUMN wedding_date VARCHAR(50) DEFAULT '' COMMENT '婚礼真实日期' AFTER style, ADD COLUMN shop_label VARCHAR(50) DEFAULT '' COMMENT '原版店名标识' AFTER wedding_date, ADD COLUMN description TEXT COMMENT '详细描述' AFTER shop_label;";
    try {
        await db.execute(sql);
        console.log("字段追加成功");
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log("字段已经存在，跳过");
        } else {
            console.error(err);
        }
    }
    await db.end();
}
main();
