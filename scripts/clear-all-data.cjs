const { Client } = require('ssh2');
const net = require('net');
const mysql = require('mysql2/promise');

const sshConfig = {
    host: '47.99.143.156',
    port: 22,
    username: 'root',
    password: '@Domi1688'
};

const localPort = 3311;

const conn = new Client();
conn.on('ready', () => {
    console.log('SSH Target established for TRUNCATE');
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
        console.log(`Local tunnel listening on ${localPort}`);

        try {
            const pool = mysql.createPool({
                host: '127.0.0.1',
                port: localPort,
                user: 'root',
                password: '@Domi1688',
                database: 'wedding'
            });

            console.log('--- 开始物理清空历史所有主题和套餐数据！ ---');
            await pool.execute('SET FOREIGN_KEY_CHECKS = 0');
            await pool.execute('TRUNCATE TABLE case_image');
            await pool.execute('TRUNCATE TABLE wedding_case');
            await pool.execute('TRUNCATE TABLE package_image');
            await pool.execute('TRUNCATE TABLE package');
            await pool.execute('SET FOREIGN_KEY_CHECKS = 1');
            console.log('✅ 数据清空完毕。现在您的系统是一张白纸，可以重新从 Admin 执行素材上传了！');
            
            process.exit(0);

        } catch (e) {
            console.error('Error:', e);
            process.exit(1);
        }
    });
}).connect(sshConfig);
