import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { UserView } from '@dialer/shared-types';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { hashPassword } from '../common/crypto/password';
import { Database, newId, Row, SqlRunner } from '../database/database';
import { OutboxService } from '../events/outbox.service';
import { assertSubset, resolveRoles, userPermissions } from '../rbac/rbac';
import { CreateUserDto, ListQueryDto, UpdateUserDto } from './dto/users.dto';

const USER_COLS = `u.id, u.email, u.display_name, u.status, u.team_id, u.last_login_at, u.created_at`;

function toView(r: Row, roles: string[]): UserView {
  return {
    id: r.id, email: r.email, displayName: r.display_name, status: r.status, roles, teamId: r.team_id,
    lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null, createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class UsersService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly outbox: OutboxService) {}

  list(actor: AuthUser, q: ListQueryDto) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const p: Record<string, unknown> = {};
      let where = '';
      if (q.search) {
        p.search = `%${q.search.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
        where += ` AND (u.email LIKE :search OR LOWER(u.display_name) LIKE :search)`;
      }
      if (q.teamId) {
        p.team = q.teamId;
        where += ` AND u.team_id = :team`;
      }
      const rows = await tx.query(
        `SELECT ${USER_COLS} FROM users u WHERE u.tenant_id = :tenantId AND u.deleted_at IS NULL${where}
          ORDER BY u.created_at DESC, u.id LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM users u WHERE u.tenant_id = :tenantId AND u.deleted_at IS NULL${where}`, p);
      const roles = await this.rolesFor(tx, rows.map((r) => r.id));
      return { items: rows.map((r) => toView(r, roles.get(r.id) ?? [])), total: Number(n), limit: q.limit, offset: q.offset };
    });
  }

  get(actor: AuthUser, id: string) {
    return this.db.withTenant(actor.tenantId, (tx) => this.load(tx, id));
  }

  async create(actor: AuthUser, dto: CreateUserDto, ctx: RequestContext) {
    const hash = await hashPassword(dto.password);
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const roles = await resolveRoles(tx, dto.roles);
      assertSubset(actor, roles.permissions, 'assign these roles');
      if (dto.teamId) await this.assertTeam(tx, dto.teamId);
      const id = newId();
      await tx.execute(
        `INSERT INTO users (id, tenant_id, email, display_name, password_hash, team_id) VALUES (:id, :tenantId, :e, :n, :h, :team)`,
        { id, e: dto.email.trim().toLowerCase(), n: dto.displayName.trim(), h: hash, team: dto.teamId ?? null },
      );
      await this.setRoles(tx, id, roles.ids);
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'user.created', entityType: 'user', entityId: id, metadata: { roles: dto.roles } }, ctx);
      await this.outbox.enqueue(tx, actor.tenantId, 'user.created', { user_id: id, roles: [...new Set(dto.roles)].sort() });
      return this.load(tx, id);
    });
  }

  /** Soft delete: the user can no longer sign in, their sessions and SIP accounts end, call history is kept, and the e-mail becomes reusable. */
  async remove(actor: AuthUser, id: string, ctx: RequestContext) {
    if (id === actor.userId) throw new BadRequestException('You cannot delete yourself');
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const existing = await tx.query(`SELECT id FROM users WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL FOR UPDATE`, { id });
      if (!existing.length) throw new NotFoundException('User not found');
      assertSubset(actor, await userPermissions(tx, id), 'delete this user');
      await tx.execute(`UPDATE users SET deleted_at = UTC_TIMESTAMP(3), status = 'disabled' WHERE tenant_id = :tenantId AND id = :id`, { id });
      await tx.execute(`UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND user_id = :id AND revoked_at IS NULL`, { id });
      await tx.execute(`UPDATE softphone_accounts SET deleted_at = UTC_TIMESTAMP(3), status = 'disabled' WHERE tenant_id = :tenantId AND user_id = :id AND deleted_at IS NULL`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'user.deleted', entityType: 'user', entityId: id }, ctx);
    });
  }

  async update(actor: AuthUser, id: string, dto: UpdateUserDto, ctx: RequestContext) {
    if (id === actor.userId && dto.status === 'disabled') throw new BadRequestException('You cannot disable yourself');
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const existing = await tx.query(`SELECT id FROM users WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL FOR UPDATE`, { id });
      if (!existing.length) throw new NotFoundException('User not found');
      // Cannot act on a user who holds permissions the actor lacks (e.g. a supervisor disabling an admin).
      assertSubset(actor, await userPermissions(tx, id), 'modify this user');
      if (dto.roles) {
        const roles = await resolveRoles(tx, dto.roles);
        assertSubset(actor, roles.permissions, 'assign these roles');
        if (id === actor.userId && actor.roles.includes('tenant_admin') && !dto.roles.includes('tenant_admin')) {
          throw new BadRequestException('You cannot remove your own tenant_admin role');
        }
        await this.setRoles(tx, id, roles.ids);
      }
      if (dto.teamId) await this.assertTeam(tx, dto.teamId);
      const sets: string[] = [];
      const p: Record<string, unknown> = { id };
      if (dto.displayName !== undefined) { sets.push('display_name = :n'); p.n = dto.displayName.trim(); }
      if (dto.status !== undefined) { sets.push('status = :s'); p.s = dto.status; }
      if (dto.teamId !== undefined) { sets.push('team_id = :team'); p.team = dto.teamId; }
      if (sets.length) await tx.execute(`UPDATE users SET ${sets.join(', ')} WHERE tenant_id = :tenantId AND id = :id`, p);
      if (dto.status === 'disabled') {
        await tx.execute(`UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND user_id = :id AND revoked_at IS NULL`, { id });
      }
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'user.updated', entityType: 'user', entityId: id, metadata: { fields: Object.keys(dto) } }, ctx);
      return this.load(tx, id);
    });
  }

  private async load(tx: SqlRunner, id: string): Promise<UserView> {
    const [row] = await tx.query(`SELECT ${USER_COLS} FROM users u WHERE u.tenant_id = :tenantId AND u.id = :id AND u.deleted_at IS NULL`, { id });
    if (!row) throw new NotFoundException('User not found');
    return toView(row, (await this.rolesFor(tx, [id])).get(id) ?? []);
  }

  private async rolesFor(tx: SqlRunner, userIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!userIds.length) return out;
    const rows = await tx.query<{ user_id: string; key: string }>(
      `SELECT ur.user_id, r.\`key\` FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.tenant_id = :tenantId
        WHERE ur.tenant_id = :tenantId AND ur.user_id IN (:ids) ORDER BY r.\`key\``, { ids: userIds });
    for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.key]);
    return out;
  }

  private async setRoles(tx: SqlRunner, userId: string, roleIds: string[]) {
    await tx.execute(`DELETE FROM user_roles WHERE tenant_id = :tenantId AND user_id = :u`, { u: userId });
    for (const r of roleIds) await tx.execute(`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES (:tenantId, :u, :r)`, { u: userId, r });
  }

  private async assertTeam(tx: SqlRunner, teamId: string) {
    const rows = await tx.query(`SELECT 1 FROM teams WHERE tenant_id = :tenantId AND id = :t AND deleted_at IS NULL`, { t: teamId });
    if (!rows.length) throw new BadRequestException('Team not found');
  }
}
