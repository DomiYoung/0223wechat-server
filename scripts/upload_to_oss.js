import OSS from 'ali-oss';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new OSS({
    region: process.env.ALIYUN_OSS_REGION,
    accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
    bucket: process.env.ALIYUN_OSS_BUCKET,
});

const DUMP_DIR = '/Users/jinjia/projects/代码项目/0305wechat-replica/api_dump';
const MAPPING_FILE = path.join(DUMP_DIR, 'mapping.json');
const OSS_PREFIX = '0305'; // 在 OSS 中的根文件夹

async function uploadToOSS() {
    if (!fs.existsSync(MAPPING_FILE)) {
        console.error('❌ mapping.json 不存在！');
        return;
    }

    const mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
    const ossMapping = {};
    const urls = Object.keys(mapping);

    console.log(`🚀 开始上传 ${urls.length} 个文件至阿里云 OSS...`);

    for (const url of urls) {
        const localRelPath = mapping[url]; // /assets/images/filename.png
        const localPath = path.join('/Users/jinjia/projects/代码项目/0305wechat-replica/api_dump', localRelPath.replace('/assets/', ''));
        
        if (!fs.existsSync(localPath)) {
            console.warn(`⚠️ 本地文件不存在 skipping: ${localPath}`);
            continue;
        }

        const ossPath = path.join(OSS_PREFIX, localRelPath.replace('/assets/', ''));

        try {
            const result = await client.put(ossPath, localPath);
            // 阿里云返回的 url 如果是 http 的话，我们换成 https
            const finalUrl = result.url.replace('http://', 'https://');
            ossMapping[url] = finalUrl;
            console.log(`✅ 上传成功: ${ossPath} -> ${finalUrl}`);
        } catch (e) {
            console.error(`❌ 上传失败 ${ossPath}:`, e.message);
        }
    }

    const ossMappingPath = path.join(DUMP_DIR, 'oss_mapping.json');
    fs.writeFileSync(ossMappingPath, JSON.stringify(ossMapping, null, 2));
    console.log(`\n🎉 上传完毕！最终映射表已保存: ${ossMappingPath}`);
}

uploadToOSS();
