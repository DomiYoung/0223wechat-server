const https = require('https');

const urls = [
    'https://photos.huajialishe.cn/zxyzm_1.jpg',
    'https://creativepro.oss-cn-shanghai.aliyuncs.com/migrated/zxyzm_1.jpg',
    'https://creativepro.oss-cn-shanghai.aliyuncs.com/migrated/nj_zxyzm_1.jpg'
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
