import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../common/auth/auth.types';
import type { SqlRunner } from '../database/database';

/** Resolves role keys (in the context tenant) to role ids + the union of their permissions. Throws on unknown keys. */
export async function resolveRoles(tx: SqlRunner, keys: string[]): Promise<{ ids: string[]; permissions: Set<string> }> {
  const unique = [...new Set(keys)];
  if (!unique.length) return { ids: [], permissions: new Set() };
  const roles = await tx.query<{ id: string; key: string }>(`SELECT id, \`key\` FROM roles WHERE tenant_id = :tenantId AND \`key\` IN (:keys)`, { keys: unique });
  if (roles.length !== unique.length) {
    const found = new Set(roles.map((r) => r.key));
    throw new BadRequestException(`Unknown role: ${unique.filter((k) => !found.has(k)).join(', ')}`);
  }
  const perms = await tx.query<{ permission_key: string }>(
    `SELECT DISTINCT permission_key FROM role_permissions WHERE tenant_id = :tenantId AND role_id IN (:ids)`, { ids: roles.map((r) => r.id) });
  return { ids: roles.map((r) => r.id), permissions: new Set(perms.map((p) => p.permission_key)) };
}

/** Effective permissions of an existing user. */
export async function userPermissions(tx: SqlRunner, userId: string): Promise<Set<string>> {
  const rows = await tx.query<{ permission_key: string }>(
    `SELECT DISTINCT rp.permission_key FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.tenant_id = :tenantId
      WHERE ur.tenant_id = :tenantId AND ur.user_id = :u`, { u: userId });
  return new Set(rows.map((r) => r.permission_key));
}

/**
 * Anti-escalation: an actor may only grant, or act on holders of, permissions the actor itself has.
 * (A supervisor with users:manage cannot create a tenant admin or disable one.)
 */
export function assertSubset(actor: AuthUser, perms: Iterable<string>, what: string): void {
  const missing = [...perms].filter((p) => !actor.permissions.has(p));
  if (missing.length) throw new ForbiddenException(`Cannot ${what}: requires permissions you do not hold (${missing.slice(0, 5).join(', ')})`);
}
