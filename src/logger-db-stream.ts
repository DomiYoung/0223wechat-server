/**
 * 数据库日志流 — 将 pino 的 error/warn 级别日志异步写入 app_error_log 表
 *
 * 设计要点：
 * 1. 只拦截 level >= 40 (warn) 的日志，info/debug/trace 不入库
 * 2. 异步批量写入，不阻塞主流程
 * 3. 自我保护：DB 写入失败时只输出到 stderr，不递归触发日志
 * 4. 防循环依赖：延迟导入 pool，避免模块初始化顺序问题
 */
import { Writable } from 'stream';

/** pino 日志级别数值（参考 pino 标准） */
const PINO_LEVEL_WARN = 40;

/** 缓冲队列：批量写入以降低 DB 压力 */
interface LogEntry {
  level: string;
  levelValue: number;
  module: string;
  message: string;
  errorStack: string;
  requestId: string;
  method: string;
  path: string;
  extraMeta: string | null;
}

const buffer: LogEntry[] = [];
const FLUSH_INTERVAL_MS = 3000;
const MAX_BUFFER_SIZE = 50;

/** 延迟获取数据库连接池，避免循环依赖 */
let poolRef: any = null;

async function getPool() {
  if (!poolRef) {
    const mod = await import('./db.js');
    poolRef = mod.default;
  }
  return poolRef;
}

/** 将级别数值转为可读名称 */
function levelToName(level: number): string {
  if (level >= 60) return 'fatal';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  return 'info';
}

/** 截断字符串，避免超长内容撑爆数据库 */
function truncate(str: string, maxLen: number): string {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

/** 批量刷写缓冲区到数据库 */
async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return;

  const batch = buffer.splice(0, MAX_BUFFER_SIZE);

  try {
    const pool = await getPool();
    const values = batch.map((entry) => [
      entry.level,
      entry.module,
      truncate(entry.message, 500),
      truncate(entry.errorStack, 4000),
      entry.requestId,
      entry.method,
      entry.path,
      entry.extraMeta,
    ]);

    await pool.query(
      `INSERT INTO app_error_log
        (level, module, message, error_stack, request_id, method, path, extra_meta)
       VALUES ?`,
      [values]
    );
  } catch (err) {
    // 自我保护：DB 写入失败时只输出到 stderr，绝不递归触发 pino
    process.stderr.write(
      `[logger-db-stream] 日志写入数据库失败: ${err instanceof Error ? err.message : String(err)}\n`
    );
    // 丢弃本批次，不回填 buffer（避免无限重试）
  }
}

/** 定时刷写 */
const flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);
flushTimer.unref?.();

/** 进程退出前最终刷写 */
process.on('beforeExit', () => {
  flushBuffer().catch(() => {});
});

/**
 * 创建 pino 自定义 Writable stream
 * pino multistream 会将 JSON 字符串写入此 stream
 */
export function createDbLogStream(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        const logObj = JSON.parse(chunk.toString());
        const levelValue: number = logObj.level ?? 30;

        // 只拦截 warn(40) 及以上级别
        if (levelValue < PINO_LEVEL_WARN) {
          callback();
          return;
        }

        const entry: LogEntry = {
          level: levelToName(levelValue),
          levelValue,
          module: logObj.module || '',
          message: logObj.msg || '',
          errorStack: logObj.err?.stack || logObj.err?.message || '',
          requestId: logObj.requestId || '',
          method: logObj.method || '',
          path: logObj.path || '',
          extraMeta: (() => {
            // 收集除已知字段外的额外信息
            const known = new Set([
              'level', 'time', 'pid', 'hostname', 'msg', 'module',
              'err', 'requestId', 'method', 'path', 'service', 'env',
              'password', 'password_hash', 'authorization',
            ]);
            const extra: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(logObj)) {
              if (!known.has(k) && v !== undefined && v !== null && v !== '') {
                extra[k] = v;
              }
            }
            return Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
          })(),
        };

        buffer.push(entry);

        // 缓冲满时立即刷写
        if (buffer.length >= MAX_BUFFER_SIZE) {
          flushBuffer().catch(() => {});
        }
      } catch {
        // JSON 解析失败：静默跳过
      }

      callback();
    },
  });
}
