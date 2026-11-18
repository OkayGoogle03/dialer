import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AuditService, normaliseIp } from '../audit/audit.service';
import type { AccessClaims, RequestContext } from '../common/auth/auth.types';
import { getDummyHash, verifyPassword } from '../common/crypto/password';
import { APP_CONFIG, AppConfig } from '../config/env';
import { Database, SqlRunner, UUID_RE } from '../database/database';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

interface UserRow {
  id: string;
  password_hash: string;
  status: string;
  failed_login_count: number;
  locked_until: Date | null;
}

const INVALID = 'Invalid credentials';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(tenantSlug: string, email: string, password: string, ctx: RequestContext): Promise<TokenPair> {
    const tenant = await this.db.resolveTenant({ slug: tenantSlug });
    if (!tenant) {
      await verifyPassword(password, await getDummyHash());
      throw new UnauthorizedException(INVALID);
    }

    const outcome = await this.db.withTenant(tenant.id, async (tx) => {
      const [user] = await tx.query<UserRow>(
        `SELECT id, password_hash, status, failed_login_count, locked_until
           FROM users WHERE tenant_id = :tenantId AND email = :email AND deleted_at IS NULL FOR UPDATE`,
        { email: email.trim().toLowerCase() },
      );
      if (!user) {
        await verifyPassword(password, await getDummyHash());
        return { ok: false as const, reason: 'unknown_user' };
      }
      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        await this.audit.log(tx, { actorUserId: user.id, action: 'auth.login_locked', entityType: 'user', entityId: user.id }, ctx);
        return { ok: false as const, reason: 'locked' };
      }
      if (!(await verifyPassword(password, user.password_hash))) {
        const failed = user.failed_login_count + 1;
        const lock = failed >= MAX_FAILED_LOGINS;
        await tx.execute(
          `UPDATE users SET failed_login_count = :failed,
                  locked_until = IF(:lock, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL :mins MINUTE), locked_until)
            WHERE tenant_id = :tenantId AND id = :id`,
          { id: user.id, failed: lock ? 0 : failed, lock, mins: LOCKOUT_MINUTES },
        );
        await this.audit.log(tx, { actorUserId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id, metadata: { locked: lock } }, ctx);
        return { ok: false as const, reason: 'bad_password' };
      }
      if (user.status !== 'active') return { ok: false as const, reason: 'disabled' };
      if (tenant.status !== 'active') {
        await this.audit.log(tx, { actorUserId: user.id, action: 'auth.login_tenant_suspended', entityType: 'user', entityId: user.id }, ctx);
        return { ok: false as const, reason: 'tenant_suspended' };
      }
      await tx.execute(
        `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND id = :id`,
        { id: user.id },
      );
      const tokens = await this.issueTokens(tx, tenant.id, user.id, randomUUID(), ctx);
      await this.audit.log(tx, { actorUserId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id }, ctx);
      return { ok: true as const, tokens };
    });

    if (outcome.ok) return outcome.tokens;
    if (outcome.reason === 'tenant_suspended') throw new ForbiddenException('Account suspended');
    throw new UnauthorizedException(INVALID);
  }

  async refresh(rawToken: string, ctx: RequestContext): Promise<TokenPair> {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) throw new UnauthorizedException('Invalid refresh token');
    // tenantId in the token is only a lookup hint: the row must exist in that tenant AND the secret must match.
    const result = await this.db.withTenant(parsed.tenantId, async (tx) => {
      const [row] = await tx.query<{ id: string; user_id: string; family_id: string; token_hash: string; expires_at: Date; rotated_at: Date | null; revoked_at: Date | null }>(
        `SELECT id, user_id, family_id, token_hash, expires_at, rotated_at, revoked_at
           FROM refresh_tokens WHERE tenant_id = :tenantId AND id = :id FOR UPDATE`,
        { id: parsed.tokenId },
      );
      if (!row || !safeEqualHex(row.token_hash, sha256(parsed.secret))) return { ok: false as const };

      const revokeFamily = () =>
        tx.execute(`UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND family_id = :f AND revoked_at IS NULL`, { f: row.family_id });

      if (row.rotated_at || row.revoked_at) {
        await revokeFamily(); // reuse of a rotated/revoked token => assume theft
        await this.audit.log(tx, { actorUserId: row.user_id, action: 'auth.refresh_reuse_detected', entityType: 'user', entityId: row.user_id }, ctx);
        return { ok: false as const };
      }
      if (row.expires_at.getTime() <= Date.now()) return { ok: false as const };

      const [user] = await tx.query<{ status: string; tenant_status: string }>(
        `SELECT u.status, t.status AS tenant_status
           FROM users u JOIN tenants t ON t.id = u.tenant_id AND t.id = :tenantId
          WHERE u.tenant_id = :tenantId AND u.id = :uid AND u.deleted_at IS NULL`,
        { uid: row.user_id },
      );
      if (!user || user.status !== 'active' || user.tenant_status !== 'active') {
        await revokeFamily();
        return { ok: false as const };
      }
      await tx.execute(`UPDATE refresh_tokens SET rotated_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND id = :id`, { id: row.id });
      return { ok: true as const, tokens: await this.issueTokens(tx, parsed.tenantId, row.user_id, row.family_id, ctx) };
    });
    if (!result.ok) throw new UnauthorizedException('Invalid refresh token');
    return result.tokens;
  }

  async logout(rawToken: string | undefined, ctx: RequestContext): Promise<void> {
    const parsed = rawToken ? parseRefreshToken(rawToken) : null;
    if (!parsed) return;
    await this.db.withTenant(parsed.tenantId, async (tx) => {
      const [row] = await tx.query<{ family_id: string; user_id: string; token_hash: string }>(
        `SELECT family_id, user_id, token_hash FROM refresh_tokens WHERE tenant_id = :tenantId AND id = :id`, { id: parsed.tokenId });
      if (!row || !safeEqualHex(row.token_hash, sha256(parsed.secret))) return;
      await tx.execute(`UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND family_id = :f AND revoked_at IS NULL`, { f: row.family_id });
      await this.audit.log(tx, { actorUserId: row.user_id, action: 'auth.logout', entityType: 'user', entityId: row.user_id }, ctx);
    });
  }

  private async issueTokens(tx: SqlRunner, tenantId: string, userId: string, familyId: string, ctx: RequestContext): Promise<TokenPair> {
    const roles = await tx.query<{ key: string }>(
      `SELECT r.\`key\` FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.tenant_id = :tenantId
        WHERE ur.tenant_id = :tenantId AND ur.user_id = :uid ORDER BY r.\`key\``,
      { uid: userId },
    );
    const perms = await tx.query<{ permission_key: string }>(
      `SELECT DISTINCT rp.permission_key FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.tenant_id = :tenantId
        WHERE ur.tenant_id = :tenantId AND ur.user_id = :uid ORDER BY rp.permission_key`,
      { uid: userId },
    );
    // Platform admin status comes only from platform_admins (writable solely by the platform DB user).
    const pa = await tx.query(
      `SELECT 1 FROM platform_admins pa JOIN tenants t ON t.id = pa.tenant_id AND t.id = :tenantId AND t.is_platform = 1
        WHERE pa.tenant_id = :tenantId AND pa.user_id = :uid`,
      { uid: userId },
    );
    // A platform super admin is a different kind of account from a tenant user: it carries NO tenant permissions, only the
    // platform flag (platform routes additionally re-check platform_admins on every request). Tenant users never get `pa`.
    const isPlatformAdmin = pa.length > 0;
    const claims: AccessClaims = isPlatformAdmin
      ? { sub: userId, tid: tenantId, roles: ['platform_admin'], perms: [], pa: true }
      : { sub: userId, tid: tenantId, roles: roles.map((r) => r.key), perms: perms.map((p) => p.permission_key) };
    const accessToken = await this.jwt.signAsync(claims, { expiresIn: this.config.jwtAccessTtlSeconds, algorithm: 'HS256' });

    const tokenId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.refreshTtlDays * 86_400_000);
    await tx.execute(
      `INSERT INTO refresh_tokens (id, tenant_id, user_id, family_id, token_hash, expires_at, user_agent, ip_address)
       VALUES (:id, :tenantId, :uid, :family, :hash, :expires, :ua, :ip)`,
      { id: tokenId, uid: userId, family: familyId, hash: sha256(secret), expires: expiresAt, ua: ctx.userAgent ?? null, ip: normaliseIp(ctx.ip) },
    );
    return {
      accessToken,
      accessTokenExpiresIn: this.config.jwtAccessTtlSeconds,
      refreshToken: `${tenantId}.${tokenId}.${secret}`,
      refreshTokenExpiresAt: expiresAt.toISOString(),
    };
  }
}

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function parseRefreshToken(raw: string): { tenantId: string; tokenId: string; secret: string } | null {
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [tenantId, tokenId, secret] = parts;
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(tokenId) || !/^[A-Za-z0-9_-]{40,60}$/.test(secret)) return null;
  return { tenantId, tokenId, secret };
}
