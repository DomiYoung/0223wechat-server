const { Client } = require('ssh2');
const net = require('net');
const child_process = require('child_process');

const sshConfig = {
    host: '47.99.143.156',
    port: 22,
    username: 'root',
    password: '@Domi1688'
};

const localPort = 3313;

const conn = new Client();
conn.on('ready', () => {
    console.log('SSH Target established for IMPORT');
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

    server.listen(localPort, '127.0.0.1', () => {
        console.log(`Local tunnel listening on ${localPort}`);
        console.log('Running import-202604.ts through tunnel...');

        const child = child_process.spawn('npx', ['tsx', 'scripts/import-202604.ts'], {
            env: { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: localPort },
            stdio: 'inherit'
        });

        child.on('close', code => {
            console.log(`import-202604.ts exited with code ${code}`);
            server.close();
            conn.end();
        });
    });
}).connect(sshConfig);
