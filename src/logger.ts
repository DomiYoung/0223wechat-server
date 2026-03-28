import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import type { MiddlewareHandler } from 'hono';
import { createDbLogStream } from './logger-db-stream.js';

const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
const logFilePath = process.env.LOG_FILE_PATH?.trim();

if (logFilePath) {
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  streams.push({
    stream: fs.createWriteStream(logFilePath, { flags: 'a' }),
  });
}

// 数据库日志流：只写入 warn(40) 及以上级别
streams.push({
  level: 'warn' as pino.Level,
  stream: createDbLogStream(),
});

export const appLogger = pino(
  {
    level: process.env.LOG_LEVEL?.trim() || 'info',
    base: {
      service: '0223wechat-server',
      env: process.env.NODE_ENV || 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
    },
    redact: {
      paths: [
        'password',
        'password_hash',
        'authorization',
        'headers.authorization',
        'req.headers.authorization',
        '*.authorization',
      ],
      censor: '[Redacted]',
    },
  },
  pino.multistream(streams)
);

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const startedAt = Date.now();
  const requestId = c.req.header('x-request-id')?.trim() || randomUUID();
  c.header('X-Request-Id', requestId);

  const log = appLogger.child({
    requestId,
    method: c.req.method,
    path: c.req.path,
  });

  try {
    await next();
    log.info(
      {
        status: c.res.status,
        durationMs: Date.now() - startedAt,
      },
      'request completed'
    );
  } catch (err) {
    log.error(
      {
        err,
        status: c.res.status || 500,
        durationMs: Date.now() - startedAt,
      },
      'request failed'
    );
    throw err;
  }
};
