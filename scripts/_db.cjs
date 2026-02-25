/**
 * 脚本公共数据库连接工具
 * 所有 scripts/ 下的脚本统一通过此模块获取 DB 连接
 * 读取项目根目录 .env 配置，不再硬编码密码
 */
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function getConnection() {
    return mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT || '3306'),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'wedding_cms',
    });
}

module.exports = { getConnection };
