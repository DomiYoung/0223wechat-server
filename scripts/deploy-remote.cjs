const { Client } = require('ssh2');
const fs = require('fs');

const sshConfig = {
    host: '47.99.143.156',
    port: 22,
    username: 'root',
    password: '@Domi1688'
};

const admin305Ts = fs.readFileSync('src/routes/admin305.ts', 'utf8');
const mpTs = fs.readFileSync('src/routes/mp.ts', 'utf8');

const conn = new Client();
conn.on('ready', () => {
    console.log('SSH connection established for DEPLOYMENT');
    conn.sftp((err, sftp) => {
        if (err) throw err;
        
        let pending = 2;
        const checkDone = () => {
            pending--;
            if (pending === 0) {
                console.log('Files uploaded successfully! Building and reloading...');
                conn.exec('cd /www/wwwroot/0223wechat-server && npm run build && pm2 reload wechat-server', (err, stream) => {
                    if (err) throw err;
                    stream.on('close', (code) => {
                        console.log('Build and restart completed with code', code);
                        conn.end();
                        process.exit(code);
                    }).on('data', data => process.stdout.write('STDOUT: ' + data))
                      .stderr.on('data', data => process.stderr.write('STDERR: ' + data));
                });
            }
        };

        sftp.writeFile('/www/wwwroot/0223wechat-server/src/routes/admin305.ts', admin305Ts, checkDone);
        sftp.writeFile('/www/wwwroot/0223wechat-server/src/routes/mp.ts', mpTs, checkDone);
    });
}).on('error', (err) => {
    console.error('SSH Error:', err);
    process.exit(1);
}).connect(sshConfig);
