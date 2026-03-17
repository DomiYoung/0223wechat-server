/**
 * 批量去除 OSS 图片加密 v2
 * 用 get + put 方式：先下载到内存再上传覆盖，新文件不加密
 */
import OSS from 'ali-oss';

const client = new OSS({
  region: process.env.ALIYUN_OSS_REGION || 'oss-cn-shanghai',
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
  bucket: process.env.ALIYUN_OSS_BUCKET || 'creativepro',
});

const PREFIXES = ['wechat-miniprogram/', '0305/', 'uploads/'];
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']);

let total = 0, success = 0, failed = 0, skipped = 0;

function isImage(name) {
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

async function processPrefix(prefix) {
  let nextMarker = '';
  let hasMore = true;

  while (hasMore) {
    const result = await client.list({ prefix, marker: nextMarker, 'max-keys': 100 });
    const objects = result.objects || [];
    if (objects.length === 0) break;

    for (const obj of objects) {
      total++;
      const name = obj.name;
      if (name.endsWith('/') || !isImage(name)) { skipped++; continue; }

      try {
        // 下载到内存
        const getResult = await client.get(name);
        const buffer = getResult.content;
        const contentType = getResult.res.headers['content-type'] || 'image/jpeg';

        // 重新上传（不加密）
        await client.put(name, buffer, {
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': 'inline',
          },
        });

        success++;
        if (success % 20 === 0) {
          console.log(`  进度: ${success} 个文件已处理...`);
        }
      } catch (err) {
        failed++;
        console.error(`  ❌ 失败: ${name} — ${err.message}`);
      }
    }

    nextMarker = result.nextMarker;
    hasMore = !!nextMarker;
  }
}

async function main() {
  console.log('🔧 开始批量去除图片加密 (v2: get+put)...');

  for (const prefix of PREFIXES) {
    console.log(`📂 处理目录: ${prefix}`);
    await processPrefix(prefix);
  }

  console.log();
  console.log('=== 完成 ===');
  console.log(`  总扫描: ${total}`);
  console.log(`  ✅ 成功: ${success}`);
  console.log(`  ⏭ 跳过: ${skipped}`);
  console.log(`  ❌ 失败: ${failed}`);

  // 验证
  console.log('\n🔍 验证...');
  const testUrl = 'https://creativepro.oss-cn-shanghai.aliyuncs.com/wechat-miniprogram/assets/bulk/1773575807181-fi78-AO1I5745.JPG';
  const processedUrl = testUrl + '?x-oss-process=image/resize,w_375/format,webp/quality,Q_75';
  
  const [origResp, compResp] = await Promise.all([
    fetch(testUrl, { method: 'HEAD' }),
    fetch(processedUrl, { method: 'HEAD' }),
  ]);
  
  const origSize = origResp.headers.get('content-length');
  const compSize = compResp.headers.get('content-length');
  const compType = compResp.headers.get('content-type');
  
  console.log(`  原图: ${(origSize/1024).toFixed(0)} KB (${origResp.headers.get('content-type')})`);
  console.log(`  压缩: ${(compSize/1024).toFixed(0)} KB (${compType})`);
  
  if (Number(compSize) < Number(origSize)) {
    console.log(`  🎉 压缩生效！节省 ${((1 - compSize/origSize) * 100).toFixed(0)}%`);
  } else {
    console.log(`  ⚠️ 压缩未生效，可能需要等 CDN 缓存刷新`);
  }
}

main().catch(err => { console.error('脚本执行失败:', err); process.exit(1); });
