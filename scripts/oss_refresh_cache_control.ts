/**
 * 批量刷新 OSS 对象缓存头
 *
 * 用法：
 *   npx tsx scripts/oss_refresh_cache_control.ts --dry-run
 *   npx tsx scripts/oss_refresh_cache_control.ts --apply
 */
import 'dotenv/config';
import OSS from 'ali-oss';
import { appLogger } from '../src/logger.js';

const log = appLogger.child({ module: 'script:oss-refresh-cache-control' });
const APPLY = process.argv.includes('--apply');
const PREFIXES = ['wechat-miniprogram/', 'uploads/'];
const TARGET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const client = new OSS({
  region: process.env.ALIYUN_OSS_REGION || 'oss-cn-shanghai',
  accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET || '',
  bucket: process.env.ALIYUN_OSS_BUCKET || 'creativepro',
});

type OssObject = {
  name: string;
};

async function listAllObjects(prefix: string): Promise<OssObject[]> {
  const items: OssObject[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await client.listV2({
      prefix,
      'max-keys': 100,
      continuationToken,
    });

    const objects = (result.objects || []).map((item) => ({ name: item.name }));
    items.push(...objects);
    continuationToken = result.nextContinuationToken;
  } while (continuationToken);

  return items;
}

async function refreshObject(name: string) {
  const head = await client.head(name);
  const headers = head.res.headers as Record<string, string | undefined>;
  const currentCacheControl = headers['cache-control'] || '';

  if (currentCacheControl === TARGET_CACHE_CONTROL) {
    return { status: 'skip', name };
  }

  if (!APPLY) {
    return { status: 'dry-run', name, from: currentCacheControl || '(empty)' };
  }

  await client.copy(name, name, {
    headers: {
      'Content-Type': headers['content-type'] || 'application/octet-stream',
      'Content-Disposition': headers['content-disposition'] || 'inline',
      'Cache-Control': TARGET_CACHE_CONTROL,
    },
  });

  return { status: 'updated', name, from: currentCacheControl || '(empty)' };
}

async function main() {
  let total = 0;
  let updated = 0;
  let skipped = 0;

  for (const prefix of PREFIXES) {
    const objects = await listAllObjects(prefix);
    log.info({ prefix, count: objects.length }, 'oss objects loaded');

    for (const object of objects) {
      total += 1;
      const result = await refreshObject(object.name);

      if (result.status === 'updated') updated += 1;
      if (result.status === 'skip') skipped += 1;

      log.info(result, 'oss cache-control processed');
    }
  }

  log.info(
    { mode: APPLY ? 'apply' : 'dry-run', total, updated, skipped, target: TARGET_CACHE_CONTROL },
    'oss cache-control refresh completed'
  );
}

main().catch((err) => {
  log.error({ err }, 'oss cache-control refresh failed');
  process.exit(1);
});
