import { SYSTEM_ROLES } from '@dialer/shared-types';
import { newId, SqlRunner } from '../database/database';
import { OutboxService } from '../events/outbox.service';

export interface ProvisionInput {
  slug: string;
  name: string;
  planKey: string;
  adminEmail: string;
  adminName: string;
  adminPasswordHash: string;
  isPlatform?: boolean;
  actor?: { userId: string; tenantId: string } | null;
}

const DEFAULT_DISPOSITIONS: [string, string, boolean, boolean, number | null][] = [
  ['SALE', 'Sale / Success', true, false, null],
  ['CALLBACK', 'Callback requested', false, false, 1440],
  ['NO_ANSWER', 'No answer', false, false, 120],
  ['BUSY', 'Busy', false, false, 30],
  ['VOICEMAIL', 'Voicemail', false, false, 240],
  ['NOT_INTERESTED', 'Not interested', false, false, null],
  ['DNC', 'Do not call', false, true, null],
];

/**
 * Creates a tenant with branding, system roles, subscription, dispositions and first admin.
 * Must run in a PLATFORM transaction (cross-tenant writes). Used by the platform API and the CLI.
 */
export async function provisionTenant(tx: SqlRunner, outbox: OutboxService, i: ProvisionInput): Promise<{ tenantId: string; adminUserId: string }> {
  const tenantId = newId();
  const adminUserId = newId();
  const [plan] = await tx.query<{ id: string }>(`SELECT id FROM plans WHERE \`key\` = :k AND is_active = 1`, { k: i.planKey });
  if (!plan) throw new Error(`unknown plan ${i.planKey}`);

  await tx.execute(`INSERT INTO tenants (id, slug, name, is_platform) VALUES (:id, :slug, :name, :p)`, { id: tenantId, slug: i.slug.toLowerCase(), name: i.name, p: !!i.isPlatform });
  await tx.execute(`INSERT INTO tenant_branding (tenant_id) VALUES (:id)`, { id: tenantId });

  let adminRoleId = '';
  for (const r of SYSTEM_ROLES) {
    const roleId = newId();
    if (r.key === 'tenant_admin') adminRoleId = roleId;
    await tx.execute(`INSERT INTO roles (id, tenant_id, \`key\`, name, is_system) VALUES (:id, :t, :k, :n, 1)`, { id: roleId, t: tenantId, k: r.key, n: r.name });
    await tx.execute(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_key) SELECT :t, :r, \`key\` FROM permissions WHERE \`key\` IN (:perms)`,
      { t: tenantId, r: roleId, perms: [...r.permissions] },
    );
  }

  await tx.execute(`INSERT INTO subscriptions (id, tenant_id, plan_id, current_period_end) VALUES (:id, :t, :p, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 MONTH))`, { id: newId(), t: tenantId, p: plan.id });
  for (const [code, label, ok, dnc, retry] of DEFAULT_DISPOSITIONS) {
    await tx.execute(
      `INSERT INTO call_dispositions (id, tenant_id, code, label, is_success, is_dnc, retry_after_minutes) VALUES (:id, :t, :c, :l, :ok, :dnc, :r)`,
      { id: newId(), t: tenantId, c: code, l: label, ok, dnc, r: retry },
    );
  }
  await tx.execute(
    `INSERT INTO users (id, tenant_id, email, display_name, password_hash) VALUES (:id, :t, :e, :n, :h)`,
    { id: adminUserId, t: tenantId, e: i.adminEmail.trim().toLowerCase(), n: i.adminName.trim(), h: i.adminPasswordHash },
  );
  await tx.execute(`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES (:t, :u, :r)`, { t: tenantId, u: adminUserId, r: adminRoleId });
  if (i.isPlatform) {
    await tx.execute(`INSERT INTO platform_admins (user_id, tenant_id, granted_by) VALUES (:u, :t, NULL)`, { u: adminUserId, t: tenantId });
  }
  await tx.execute(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_tenant_id, action, entity_type, entity_id, metadata)
     VALUES (:id, :t, :au, :at, 'tenant.provisioned', 'tenant', :t, :m)`,
    { id: newId(), t: tenantId, au: i.actor?.userId ?? null, at: i.actor?.tenantId ?? null, m: JSON.stringify({ plan: i.planKey, platform: !!i.isPlatform }) },
  );
  await outbox.enqueueForTenant(tx, tenantId, 'tenant.created', { slug: i.slug.toLowerCase(), name: i.name, plan_key: i.planKey });
  return { tenantId, adminUserId };
}
