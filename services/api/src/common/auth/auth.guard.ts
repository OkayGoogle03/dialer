import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { UUID_RE } from '../../database/database';
import { requestContext } from '../logging/context';
import type { AccessClaims, AuthUser } from './auth.types';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';
import { TenantStatusService } from './tenant-status.service';

/** Global guard: verifies the access JWT, rejects suspended tenants, enforces @RequirePermissions. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector, private readonly tenants: TenantStatusService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Missing bearer token');

    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (!UUID_RE.test(claims.sub ?? '') || !UUID_RE.test(claims.tid ?? '')) throw new UnauthorizedException('Invalid token');

    req.user = {
      userId: claims.sub,
      tenantId: claims.tid,
      roles: claims.roles ?? [],
      permissions: new Set(claims.perms ?? []),
      isPlatformAdmin: claims.pa === true,
    };
    const store = requestContext.getStore();
    if (store) {
      store.tenantId = claims.tid;
      store.userId = claims.sub;
    }

    const status = await this.tenants.status(claims.tid);
    if (status !== 'active') throw new ForbiddenException('Account suspended');

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const missing = required.filter((p) => !req.user!.permissions.has(p));
    if (missing.length) throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    return true;
  }
}
