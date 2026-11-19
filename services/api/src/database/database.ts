import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';

export type Params = Record<string, unknown>;
export type Row = Record<string, any>;

/** Minimal SQL surface used by services. Named placeholders (:name) only. */
export interface SqlRunner {
  query<T = Row>(sql: string, params?: Params): Promise<T[]>;
  execute(sql: string, params?: Params): Promise<{ affectedRows: number }>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const newId = () => randomUUID();

/**
 * Tables whose rows belong to one tenant. TiDB has no row-level security, so isolation is enforced by:
 *  1. TenantScopeGuard (below): every reference to one of these tables in a tenant transaction must be matched
 *     by a :tenantId bind, and :tenantId is always bound from the verified context (callers cannot pass it).
 *  2. Composite (tenant_id, id) foreign keys — the database rejects cross-tenant references.
 *  3. DB-user grants — the API user cannot write tenants/platform_admins or mutate audit logs.
 * Keep this list in sync with migrations (asserted by the isolation test suite).
 */
export const TENANT_TABLES = new Set([
  'tenants', 'tenant_branding', 'roles', 'role_permissions', 'teams', 'users', 'platform_admins', 'user_roles',
  'refresh_tokens', 'audit_logs', 'tenant_sip_providers', 'caller_ids', 'extensions', 'queues', 'queue_agents',
  'call_dispositions', 'call_sessions', 'call_legs', 'call_events', 'recordings', 'contact_lists', 'contacts',
  'dnc_entries', 'consent_records', 'campaigns', 'campaign_contacts', 'knowledge_bases', 'knowledge_documents',
  'ai_agents', 'ai_tools', 'ai_agent_tools', 'ai_sessions', 'ai_transcripts', 'subscriptions', 'usage_records',
  'invoices', 'outbox_events', 'idempotency_keys', 'service_providers', 'call_servers', 'provider_dids',
  'outbound_processes', 'process_provider_assignments', 'process_did_assignments', 'process_server_assignments',
  'caller_import_batches', 'caller_import_records', 'caller_assignments', 'outbound_calls', 'softphone_accounts',
]);
/** Shared catalogue tables readable without tenant scope. */
export const GLOBAL_TABLES = new Set(['permissions', 'plans', 'sip_providers']);

export class TenantScopeError extends Error {}

const TABLE_REF = /\b(?:FROM|JOIN|UPDATE|INTO)\s+`?([a-z_][a-z0-9_]*)`?/gi;
const COMMA_JOIN = /\bFROM\s+`?[a-z_][a-z0-9_]*`?(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?\s*,/i;

export function tenantTablesIn(sql: string): string[] {
  return [...sql.matchAll(TABLE_REF)].map((m) => m[1].toLowerCase()).filter((t) => TENANT_TABLES.has(t));
}

/** Throws unless each tenant-table reference has its own :tenantId predicate/value. */
export function assertTenantScoped(sql: string): void {
  if (COMMA_JOIN.test(sql)) throw new TenantScopeError('comma joins are not allowed; use explicit JOIN ... ON ... AND x.tenant_id = :tenantId');
  const refs = tenantTablesIn(sql);
  const binds = (sql.match(/:tenantId\b/g) ?? []).length;
  if (binds < refs.length) {
    throw new TenantScopeError(`query references tenant tables [${refs.join(', ')}] but has only ${binds} :tenantId bind(s)`);
  }
}

export function assertNoTenantTables(sql: string): void {
  const refs = tenantTablesIn(sql);
  if (refs.length) throw new TenantScopeError(`tenant tables [${refs.join(', ')}] require a tenant transaction`);
}

function runner(conn: PoolConnection, guard: (sql: string) => void, bound: Params = {}): SqlRunner {
  // mysql2 named placeholders accept a plain object; its QueryValues typing does not model that.
  const merge = (params?: Params): any => {
    if (params && 'tenantId' in params) throw new TenantScopeError('tenantId is bound from context and cannot be supplied');
    return { ...params, ...bound };
  };
  return {
    async query<T>(sql: string, params?: Params) {
      guard(sql);
      const [rows] = await conn.query(sql, merge(params));
      return rows as T[];
    },
    async execute(sql: string, params?: Params) {
      guard(sql);
      const [res] = await conn.query(sql, merge(params));
      return { affectedRows: (res as ResultSetHeader).affectedRows ?? 0 };
    },
  };
}

async function inTransaction<T>(pool: Pool, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback().catch(() => undefined);
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Tenant-facing data access (DB user dialer_api).
 * withTenant: tenantId MUST come from a verified JWT or a server-side lookup, never from request input.
 */
export class Database {
  constructor(private readonly pool: Pool) {}

  withTenant<T>(tenantId: string, fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) throw new TenantScopeError('invalid tenant id');
    return inTransaction(this.pool, (conn) => fn(runner(conn, assertTenantScoped, { tenantId })));
  }

  /** Global catalogue reads only (permissions, plans, ...). Tenant tables are rejected. */
  withoutTenant<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return inTransaction(this.pool, (conn) => fn(runner(conn, assertNoTenantTables)));
  }

  /** Pre-auth: resolve a tenant by slug or custom domain. Fixed query, non-sensitive columns only. */
  async resolveTenant(by: { slug?: string; domain?: string }): Promise<{ id: string; slug: string; name: string; status: string } | null> {
    const [rows] = await this.pool.query(
      `SELECT id, slug, name, status FROM tenants WHERE deleted_at IS NULL AND (slug = :slug OR custom_domain = :domain) LIMIT 1`,
      { slug: by.slug?.toLowerCase() ?? null, domain: by.domain?.toLowerCase() ?? null },
    );
    return ((rows as Row[])[0] as { id: string; slug: string; name: string; status: string }) ?? null;
  }

  /** Pre-auth: presentation-only branding for the login page. */
  async publicBranding(tenantId: string): Promise<Row | null> {
    const [rows] = await this.pool.query(
      `SELECT product_name AS productName, logo_url AS logoUrl, favicon_url AS faviconUrl, primary_color AS primaryColor,
              secondary_color AS secondaryColor, accent_color AS accentColor
         FROM tenant_branding WHERE tenant_id = :tenantId`,
      { tenantId },
    );
    return (rows as Row[])[0] ?? null;
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

/**
 * Cross-tenant access (DB user dialer_platform). Only the platform module, outbox relay, event consumers and
 * provisioning CLI may receive this. Never inject it into tenant-facing controllers.
 */
export class PlatformDatabase {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.withPlatform((tx) => tx.query('SELECT 1'));
  }

  withPlatform<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return inTransaction(this.pool, (conn) => fn(runner(conn, () => undefined)));
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
