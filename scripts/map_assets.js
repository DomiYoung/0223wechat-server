const fs = require('fs');
const path = require('path');

const DUMP_DIR = '/Users/jinjia/projects/代码项目/0305wechat-replica/api_dump';
const IMAGES_DIR = path.join(DUMP_DIR, 'images');
const VIDEOS_DIR = path.join(DUMP_DIR, 'videos');

async function generateMapping() {
    const mapping = {};
    const files = fs.readdirSync(IMAGES_DIR);
    
    // 我们需要通过文件名反推原始 URL 或者直接建立映射
    // 因为之前的 dump.js 没有保存映射，我们现在通过遍历 JSON 文件来重建它
    
    const jsonFiles = fs.readdirSync(DUMP_DIR).filter(f => f.endsWith('.json') && f !== 'mapping.json');
    
    console.log('🔍 正在扫描 JSON 文件以重建 URL 映射...');
    
    jsonFiles.forEach(file => {
        const content = fs.readFileSync(path.join(DUMP_DIR, file), 'utf8');
        try {
            const data = JSON.parse(content);
            
            function traverse(obj) {
                if (!obj || typeof obj !== 'object') return;
                
                for (const key in obj) {
                    const value = obj[key];
                    if (typeof value === 'string' && value.startsWith('http')) {
                        // 这是一个 URL，我们需要找到它对应的本地文件
                        // 逻辑：safeFilename-timestamp.ext
                        // 我们尝试匹配前缀
                        const urlMatch = files.find(f => {
                            // 这里逻辑稍微复杂，因为文件名是 safeFilename 化的
                            // 简单起见，如果我们要 1:1，最稳妥的是重新生成一份带映射的 dump
                            // 但用户问为啥还在跑，说明他希望直接利用现有文件
                        });
                    }
                    traverse(obj[key]);
                }
            }
            traverse(data);
        } catch (e) {}
    });
}
