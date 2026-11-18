import { LoggerService } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pino, { DestinationStream, Logger } from 'pino';
import { requestContext } from './context';

/** Structured JSON logger. Every line carries correlation_id / tenant_id / user_id from the request context. */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin() {
        const c = requestContext.getStore();
        return c ? { correlation_id: c.correlationId, tenant_id: c.tenantId, user_id: c.userId } : {};
      },
      redact: {
        paths: ['password', '*.password', 'adminPassword', '*.adminPassword', 'refreshToken', '*.refreshToken', 'req.headers.authorization', 'req.headers.cookie', '*.token_hash'],
        censor: '[REDACTED]',
      },
    },
    destination,
  );
}

/** Adapter so Nest's internal logs go through pino. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string) { this.logger.info({ context }, String(message)); }
  error(message: unknown, trace?: string, context?: string) { this.logger.error({ context, trace }, String(message)); }
  warn(message: unknown, context?: string) { this.logger.warn({ context }, String(message)); }
  debug(message: unknown, context?: string) { this.logger.debug({ context }, String(message)); }
  verbose(message: unknown, context?: string) { this.logger.trace({ context }, String(message)); }
}

const CORRELATION_RE = /^[A-Za-z0-9._:-]{1,100}$/;

/** Assigns/propagates X-Correlation-Id, runs the request inside the context store, writes one access-log line. */
export function requestLoggingMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-correlation-id'];
    const correlationId = typeof incoming === 'string' && CORRELATION_RE.test(incoming) ? incoming : randomUUID();
    req.headers['x-correlation-id'] = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    const started = process.hrtime.bigint();
    const store = { correlationId } as { correlationId: string; tenantId?: string; userId?: string };
    res.on('finish', () => {
      requestContext.run(store, () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        logger[lvl]({ http: { method: req.method, path: req.path, status: res.statusCode, duration_ms: Math.round(ms * 10) / 10, ip: req.ip } }, 'request');
      });
    });
    requestContext.run(store, () => next());
  };
}
