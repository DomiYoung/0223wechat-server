import fs from 'fs';
import path from 'path';

const DUMP_DIR = '/Users/jinjia/projects/代码项目/0305wechat-replica/api_dump';
const OSS_MAPPING_FILE = path.join(DUMP_DIR, 'oss_mapping.json');

async function replaceUrls() {
    if (!fs.existsSync(OSS_MAPPING_FILE)) {
        console.error('❌ oss_mapping.json 不存在！请先跑 upload_to_oss.js');
        return;
    }

    const mapping = JSON.parse(fs.readFileSync(OSS_MAPPING_FILE, 'utf8'));
    const jsonFiles = fs.readdirSync(DUMP_DIR).filter(f => f.endsWith('.json') && f !== 'mapping.json' && f !== 'oss_mapping.json');

    console.log(`🚀 开始在 ${jsonFiles.length} 个 JSON 文件中进行 1:1 链接替换...`);

    let totalReplacements = 0;

    for (const file of jsonFiles) {
        const filePath = path.join(DUMP_DIR, file);
        let content = fs.readFileSync(filePath, 'utf8');
        let count = 0;

        for (const originalUrl in mapping) {
            const ossUrl = mapping[originalUrl];
            // 使用完全匹配替换链接
            if (content.includes(originalUrl)) {
                // 转义特殊字符用于正则
                const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedUrl, 'g');
                content = content.replace(regex, ossUrl);
                count++;
                totalReplacements++;
            }
        }

        fs.writeFileSync(filePath, content);
        console.log(`✅ ${file}: 替换了 ${count} 处链接`);
    }

    console.log(`\n🎉 替换完成！总计替换次数: ${totalReplacements}`);
}

replaceUrls();
