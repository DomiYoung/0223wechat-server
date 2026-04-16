const { Client } = require('ssh2');
const net = require('net');
const mysql = require('mysql2/promise');

const sshConfig = {
    host: '47.99.143.156',
    port: 22,
    username: 'root',
    password: '@Domi1688'
};

const localPort = 3314;

const conn = new Client();
conn.on('ready', () => {
    const server = net.createServer(socket => {
        conn.forwardOut(
            socket.remoteAddress,
            socket.remotePort,
            '127.0.0.1',
            3306,
            (err, stream) => {
                if (err) {
                    socket.end();
                    return;
                }
                socket.pipe(stream).pipe(socket);
            }
        );
    });

    server.listen(localPort, '127.0.0.1', async () => {
        try {
            const pool = mysql.createPool({
                host: '127.0.0.1',
                port: localPort,
                user: 'root',
                password: '@Domi1688',
                database: 'wedding',
                waitForConnections: true,
                connectionLimit: 1,
            });
            const [rows] = await pool.execute('SELECT id, title, price, price_label FROM package');
            console.table(rows);
            await pool.end();
        } catch (e) {
            console.error(e);
        } finally {
            server.close();
            conn.end();
            process.exit(0);
        }
    });
}).connect(sshConfig);
