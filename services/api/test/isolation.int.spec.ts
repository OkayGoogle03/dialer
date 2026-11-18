import { PERMISSIONS } from '@dialer/shared-types';
import mysql from 'mysql2/promise';
import { Database, newId, PlatformDatabase, TENANT_TABLES, TenantScopeError } from '../src/database/database';
import { ownerConnection, pools, provision, RUN, testConfig } from './support/harness';

describe('tenant isolation without RLS: guard + composite FKs + DB grants (TiDB)', () => {
  let db: Database;
  let platformDb: PlatformDatabase;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    ({ db, platformDb } = pools());
    tenantA = (await provision(platformDb, `iso-a-${RUN}`, `a@iso-${RUN}.test`, 'password-aaaa-1')).tenantId;
    tenantB = (await provision(platformDb, `iso-b-${RUN}`, `b@iso-${RUN}.test`, 'password-bbbb-1')).tenantId;
  });

  afterAll(async () => {
    await db.close();
    await platformDb.close();
  });

  it('TENANT_TABLES covers every table with a tenant_id column', async () => {
    const c = await ownerConnection();
    const [rows] = await c.query(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id'`);
    await c.end();
    const withTenantId = (rows as { t: string }[]).map((r) => r.t);
    expect(withTenantId.length).toBeGreaterThan(30);
    expect(withTenantId.filter((t) => !TENANT_TABLES.has(t))).toEqual([]);
  });

  it('permission catalogue in the DB matches @dialer/shared-types', async () => {
    const rows = await db.withoutTenant((tx) => tx.query<{ key: string }>('SELECT `key` FROM permissions ORDER BY `key`'));
    expect(rows.map((r) => r.key)).toEqual([...PERMISSIONS].sort());
  });

  it('each tenant sees only its own rows', async () => {
    const a = await db.withTenant(tenantA, (tx) => tx.query<{ email: string }>('SELECT email FROM users WHERE tenant_id = :tenantId'));
    expect(a.map((r) => r.email)).toEqual([`a@iso-${RUN}.test`]);
    const t = await db.withTenant(tenantA, (tx) => tx.query<{ id: string }>('SELECT id FROM tenants WHERE id = :tenantId'));
    expect(t.map((r) => r.id)).toEqual([tenantA]);
  });

  it('the guard rejects unscoped queries before they reach the database', async () => {
    await expect(db.withTenant(tenantA, (tx) => tx.query('SELECT email FROM users'))).rejects.toThrow(TenantScopeError);
    await expect(db.withTenant(tenantA, (tx) => tx.execute('UPDATE users SET display_name = :n', { n: 'x' }))).rejects.toThrow(TenantScopeError);
  });

  it('callers cannot override the bound tenant id', async () => {
    await expect(db.withTenant(tenantA, (tx) => tx.query('SELECT * FROM users WHERE tenant_id = :tenantId', { tenantId: tenantB }))).rejects.toThrow(/bound from context/);
  });

  it('withoutTenant cannot touch tenant tables', async () => {
    await expect(db.withoutTenant((tx) => tx.query('SELECT * FROM users WHERE tenant_id = :t', { t: tenantA }))).rejects.toThrow(TenantScopeError);
  });

  it('scoped writes cannot modify another tenant even when targeting its row id', async () => {
    const [bUser] = await db.withTenant(tenantB, (tx) => tx.query<{ id: string }>('SELECT id FROM users WHERE tenant_id = :tenantId'));
    const r = await db.withTenant(tenantA, (tx) => tx.execute(`UPDATE users SET display_name = 'pwned' WHERE tenant_id = :tenantId AND id = :id`, { id: bUser.id }));
    expect(r.affectedRows).toBe(0);
  });

  it('composite foreign keys reject cross-tenant references', async () => {
    const teamB = newId();
    await db.withTenant(tenantB, (tx) => tx.execute(`INSERT INTO teams (id, tenant_id, name) VALUES (:id, :tenantId, 'B team')`, { id: teamB }));
    await expect(
      db.withTenant(tenantA, (tx) => tx.execute(`UPDATE users SET team_id = :team WHERE tenant_id = :tenantId`, { team: teamB })),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
  });

  it('API DB user is denied privileged operations by grants', async () => {
    const cfg = testConfig();
    const c = await mysql.createConnection({ host: cfg.db.host, port: cfg.db.port, database: cfg.db.name, user: cfg.db.apiUser, password: cfg.db.apiPassword, ssl: cfg.db.tls ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined });
    // MySQL: 1142 ER_TABLEACCESS_DENIED_ERROR. TiDB reports some DML denials as 8121 "privilege check ... fail".
    const denied = async (sql: string) => {
      const err = await c.query(sql).then(() => null, (e: { errno?: number }) => e);
      expect({ sql, denied: [1142, 8121].includes(err?.errno ?? 0) }).toEqual({ sql, denied: true });
    };
    try {
      await denied(`DELETE FROM audit_logs WHERE tenant_id = '${tenantA}'`);
      await denied(`UPDATE audit_logs SET action = 'x' WHERE tenant_id = '${tenantA}'`);
      await denied(`INSERT INTO tenants (id, slug, name) VALUES ('${newId()}', 'mallory-${RUN}', 'M')`);
      await denied(`UPDATE tenants SET status = 'active' WHERE id = '${tenantA}'`);
      await denied(`INSERT INTO platform_admins (user_id, tenant_id) VALUES ('${newId()}', '${tenantA}')`);
      await denied(`SELECT * FROM outbox_events LIMIT 1`);
      await denied(`DROP TABLE teams`);
    } finally {
      await c.end();
    }
  });

  it('platform DB user cannot mutate audit logs either', async () => {
    const err = await platformDb.withPlatform((tx) => tx.execute(`DELETE FROM audit_logs WHERE tenant_id = :t`, { t: tenantA })).then(() => null, (e: { errno?: number }) => e);
    expect([1142, 8121]).toContain(err?.errno);
  });
});
