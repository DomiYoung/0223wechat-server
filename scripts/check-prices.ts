import mysql from 'mysql2/promise';

async function main() {
  const pool = mysql.createPool({
    host: '47.99.143.156',
    port: 3306,
    user: 'root',
    password: '@Domi1688',
    database: 'wedding',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  const [rows] = await pool.execute('SELECT id, title, price, price_label FROM package');
  console.table(rows);
  process.exit(0);
}

main().catch(console.error);
