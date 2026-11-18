import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { currentCorrelationId } from '../logging/context';

export const LOGGER = Symbol('LOGGER');

/** Consistent error envelope: { error: { status, code, message, details?, correlationId } } */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId = currentCorrelationId() ?? (req.headers['x-correlation-id'] as string | undefined) ?? null;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') message = body;
      else if (body && typeof body === 'object') {
        const b = body as { message?: unknown };
        if (Array.isArray(b.message)) {
          message = 'Validation failed';
          details = b.message;
        } else if (typeof b.message === 'string') message = b.message;
      }
    } else {
      const code = (exception as { code?: string })?.code;
      if (code === 'ER_DUP_ENTRY') {
        status = HttpStatus.CONFLICT;
        message = 'Resource already exists';
      } else if (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_NO_REFERENCED_ROW') {
        status = HttpStatus.UNPROCESSABLE_ENTITY;
        message = 'Referenced resource does not exist';
      } else if (code === 'ER_ROW_IS_REFERENCED_2') {
        status = HttpStatus.CONFLICT;
        message = 'Resource is still in use';
      }
    }
    if (status >= 500) this.logger.error({ err: exception, path: req.path }, 'unhandled error');

    res.status(status).json({
      error: { status, code: HttpStatus[status] ?? 'ERROR', message, ...(details ? { details } : {}), ...(correlationId ? { correlationId } : {}) },
    });
  }
}
