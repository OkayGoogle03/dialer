import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { currentCorrelationId } from '../logging/context';
import type { AuthUser, RequestContext } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const REQUIRED_PERMISSIONS = 'requiredPermissions';

/** Route does not require an access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route requires ALL listed permissions. */
export const RequirePermissions = (...perms: string[]) => SetMetadata(REQUIRED_PERMISSIONS, perms);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  if (!req.user) throw new Error('CurrentUser used on unauthenticated route');
  return req.user;
});

export const ReqContext = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 500),
    correlationId: currentCorrelationId() ?? undefined,
  };
});
