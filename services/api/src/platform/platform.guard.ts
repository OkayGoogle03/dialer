import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../common/auth/auth.types';
import { PlatformDatabase } from '../database/database';

/**
 * Runs after the global AuthGuard. A valid JWT `pa` claim is necessary but not sufficient: the user must still be
 * an active member of the platform tenant AND listed in platform_admins (re-checked on every request, so
 * revocation is immediate). Tenant users can never satisfy this — platform_admins is not writable by the API DB user.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly db: PlatformDatabase) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const u = req.user;
    if (!u?.isPlatformAdmin) throw new ForbiddenException('Platform administrator access required');
    const rows = await this.db.withPlatform((tx) =>
      tx.query(
        `SELECT 1 FROM platform_admins pa
           JOIN users usr ON usr.id = pa.user_id AND usr.tenant_id = pa.tenant_id AND usr.status = 'active' AND usr.deleted_at IS NULL
           JOIN tenants t ON t.id = pa.tenant_id AND t.is_platform = 1 AND t.status = 'active'
          WHERE pa.user_id = :u AND pa.tenant_id = :t`,
        { u: u.userId, t: u.tenantId },
      ));
    if (!rows.length) throw new ForbiddenException('Platform administrator access required');
    return true;
  }
}
