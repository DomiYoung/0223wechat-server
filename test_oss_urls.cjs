const https = require('https');

const urls = [
    'https://creativepro.oss-cn-shanghai.aliyuncs.com/migrated/reqiqiu_nj_cover.jpg',
    'https://creativepro.oss-cn-shanghai.aliyuncs.com/migrated/nj_reqiqiu_nj_cover.jpg',
    'https://creativepro.oss-cn-shanghai.aliyuncs.com/migrated/nj_reqiqiu_cover.jpg',
    'https://creativepro.oss-cn-shanghai.aliyuncs.com/migrated/zxyzm_nj_cover.jpg',
    'https://creativepro.oss-cn-shanghai.aliyuncs.com/migrated/nj_zxyzm_nj_cover.jpg',
    'https://creativepro.oss-cn-shanghai.aliyuncs.com/migrated/nj_zxyzm_cover.jpg'
];

async function check(url) {
    return new Promise((resolve) => {
        https.request(url, { method: 'HEAD' }, (res) => {
            console.log(`[${res.statusCode}] ${url}`);
            resolve(res.statusCode === 200);
        }).end();
    });
}

async function run() {
    for (const url of urls) {
        await check(url);
    }
}
run();
