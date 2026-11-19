#!/usr/bin/env node
// Database control for TiDB / MySQL 8.
//   node database/dbctl.mjs migrate      [--db name]   apply migrations (owner credentials)
//   node database/dbctl.mjs setup-roles  [--db name]   create/sync dialer_api + dialer_platform users and table grants
//   node database/dbctl.mjs reset-test                 drop+recreate <DB_NAME>_test, migrate, grant (tests/CI only)
//   node database/dbctl.mjs status       [--db name]
// Env: DB_HOST, DB_PORT, DB_NAME, DB_TLS, DB_OWNER_USER, DB_OWNER_PASSWORD, DB_USER_PREFIX,
//      DB_API_PASSWORD, DB_PLATFORM_PASSWORD
//
// DDL is not transactional in TiDB, so each statement is tracked individually: a failed run can be re-run
// and resumes at the failed statement. Editing an applied statement is rejected (checksum).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// ---- Grant policy. Every table must be classified; unclassified tables abort setup-roles.
const API_GRANTS = {
  tenants: 'SELECT',
  permissions: 'SELECT',
  plans: 'SELECT',
  sip_providers: 'SELECT',
  subscriptions: 'SELECT',
  invoices: 'SELECT',
  platform_admins: 'SELECT',
  audit_logs: 'SELECT, INSERT',
  call_events: 'SELECT, INSERT',
  ai_transcripts: 'SELECT, INSERT',
  consent_records: 'SELECT, INSERT',
  usage_records: 'SELECT, INSERT',
  outbox_events: 'INSERT',
  role_permissions: 'SELECT, INSERT, DELETE',
  user_roles: 'SELECT, INSERT, DELETE',
  ai_agent_tools: 'SELECT, INSERT, DELETE',
  refresh_tokens: 'SELECT, INSERT, UPDATE',
  processed_events: null,
  schema_migrations: null,
  // full DML for ordinary tenant-owned tables
  ...Object.fromEntries([
    'tenant_branding', 'roles', 'teams', 'users', 'tenant_sip_providers', 'caller_ids', 'extensions', 'queues',
    'queue_agents', 'call_dispositions', 'call_sessions', 'call_legs', 'recordings', 'contact_lists', 'contacts',
    'dnc_entries', 'campaigns', 'campaign_contacts', 'knowledge_bases', 'knowledge_documents', 'ai_agents',
    'ai_tools', 'ai_sessions', 'idempotency_keys', 'service_providers', 'call_servers', 'provider_dids',
    'outbound_processes', 'process_provider_assignments', 'process_did_assignments', 'process_server_assignments',
    'caller_import_batches', 'caller_import_records', 'caller_assignments', 'outbound_calls', 'softphone_accounts',
  ].map((t) => [t, 'SELECT, INSERT, UPDATE, DELETE'])),
};
const PLATFORM_OVERRIDES = { audit_logs: 'SELECT, INSERT', schema_migrations: null };

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

export function connOptions(database) {
  return {
    host: env('DB_HOST', '127.0.0.1'),
    port: Number(env('DB_PORT', '4000')),
    user: env('DB_OWNER_USER'),
    password: env('DB_OWNER_PASSWORD', ''),
    database,
    ssl: env('DB_TLS', 'false') === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
    timezone: 'Z',
  };
}

export function loadStatements() {
  const out = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.replace(/(^|\s)--\s.*$/, '').replace(/^\s*--.*$/, ''))
      .join('\n');
    text.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean).forEach((sql, i) => {
      out.push({ file, n: i + 1, sql, checksum: createHash('sha256').update(sql).digest('hex') });
    });
  }
  return out;
}

const ident = (s) => {
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`unsafe identifier ${s}`);
  return '`' + s + '`';
};

export async function migrate(db) {
  const c = await mysql.createConnection(connOptions());
  try {
    await c.query(`CREATE DATABASE IF NOT EXISTS ${ident(db)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    await c.query(`USE ${ident(db)}`);
    await c.query(`SET time_zone = '+00:00'`);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      file VARCHAR(100) NOT NULL, n INT NOT NULL, checksum CHAR(64) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (file, n))`);
    const [[lock]] = await c.query(`SELECT GET_LOCK(?, 30) AS l`, [`dialer_migrate_${db}`]);
    if (lock.l !== 1) throw new Error('could not acquire migration lock');
    const [rows] = await c.query('SELECT file, n, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [`${r.file}#${r.n}`, r.checksum]));
    let count = 0;
    for (const s of loadStatements()) {
      const prev = applied.get(`${s.file}#${s.n}`);
      if (prev) {
        if (prev !== s.checksum) throw new Error(`checksum mismatch: ${s.file} statement ${s.n} was edited after being applied`);
        continue;
      }
      try {
        await c.query(s.sql);
      } catch (e) {
        throw new Error(`${s.file} statement ${s.n} failed: ${e.message}\n${s.sql.slice(0, 200)}`);
      }
      await c.query('INSERT INTO schema_migrations (file, n, checksum) VALUES (?, ?, ?)', [s.file, s.n, s.checksum]);
      count++;
    }
    await c.query(`SELECT RELEASE_LOCK(?)`, [`dialer_migrate_${db}`]);
    console.log(`[dbctl] ${db}: applied ${count} statement(s)`);
  } finally {
    await c.end();
  }
}

export async function setupRoles(db) {
  const prefix = process.env.DB_USER_PREFIX ?? '';
  const users = [
    { name: `${prefix}dialer_api`, password: env('DB_API_PASSWORD'), policy: API_GRANTS },
    { name: `${prefix}dialer_platform`, password: env('DB_PLATFORM_PASSWORD'), policy: null },
  ];
  const c = await mysql.createConnection(connOptions(db));
  try {
    const [tables] = await c.query(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [db]);
    const names = tables.map((r) => r.t);
    const unclassified = names.filter((t) => !(t in API_GRANTS));
    if (unclassified.length) throw new Error(`unclassified tables (add to API_GRANTS): ${unclassified.join(', ')}`);
    for (const u of users) {
      if (u.password.length < 16) throw new Error(`password for ${u.name} must be >= 16 chars`);
      await c.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [u.name, u.password]);
      await c.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [u.name, u.password]);
      for (const t of names) {
        await c.query(`REVOKE ALL PRIVILEGES ON ${ident(db)}.${ident(t)} FROM ?@'%'`, [u.name]).catch(() => undefined);
        const privs = u.policy ? u.policy[t] : t in PLATFORM_OVERRIDES ? PLATFORM_OVERRIDES[t] : 'SELECT, INSERT, UPDATE, DELETE';
        if (privs) await c.query(`GRANT ${privs} ON ${ident(db)}.${ident(t)} TO ?@'%'`, [u.name]);
      }
      console.log(`[dbctl] ${db}: grants applied for ${u.name}`);
    }
  } finally {
    await c.end();
  }
}

export async function resetTestDb() {
  const db = `${env('DB_NAME')}_test`;
  if (!db.endsWith('_test')) throw new Error('refusing to reset a non-test database');
  const c = await mysql.createConnection(connOptions());
  await c.query(`DROP DATABASE IF EXISTS ${ident(db)}`);
  await c.end();
  await migrate(db);
  await setupRoles(db);
  return db;
}

/** Migrate + grant the test DB; resets it only if an applied migration was edited. */
export async function prepareTestDb() {
  const db = `${env('DB_NAME')}_test`;
  try {
    await migrate(db);
  } catch (e) {
    if (!/checksum mismatch/.test(e.message)) throw e;
    console.log('[dbctl] migrations changed; resetting test database');
    return resetTestDb();
  }
  await setupRoles(db);
  return db;
}

async function status(db) {
  const c = await mysql.createConnection(connOptions(db));
  const [rows] = await c.query('SELECT file, COUNT(*) AS statements, MAX(applied_at) AS last FROM schema_migrations GROUP BY file ORDER BY file');
  console.table(rows);
  await c.end();
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { db: { type: 'string' } } });
  const db = values.db ?? env('DB_NAME');
  switch (positionals[0]) {
    case 'migrate': return migrate(db);
    case 'setup-roles': return setupRoles(db);
    case 'reset-test': return void (await resetTestDb());
    case 'prepare-test': return void (await prepareTestDb());
    case 'status': return status(db);
    default: throw new Error('usage: dbctl.mjs migrate|setup-roles|reset-test|status [--db name]');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`[dbctl] ${e.message}`); process.exit(1); });
}
