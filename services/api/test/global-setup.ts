import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createConnection } from 'mysql2/promise';

/**
 * Prints the database round-trip time at the start of every run. The integration tests do hundreds of sequential queries against a remote TiDB, so
 * a run is only as fast as that link; when a test later hits its timeout, this line says whether the database was slow at the time. It never fails the run.
 */
async function reportDbLatency(): Promise<void> {
  const e = process.env;
  try {
    const user = e.DB_USER_PREFIX && e.DB_OWNER_USER?.startsWith(e.DB_USER_PREFIX) ? e.DB_OWNER_USER : `${e.DB_USER_PREFIX ?? ''}${e.DB_OWNER_USER ?? ''}`;
    const t0 = Date.now();
    const c = await createConnection({ host: e.DB_HOST, port: Number(e.DB_PORT ?? 4000), database: e.DB_NAME, user, password: e.DB_OWNER_PASSWORD, ssl: e.DB_TLS === 'false' ? undefined : { minVersion: 'TLSv1.2' }, connectTimeout: 20000 });
    const connectMs = Date.now() - t0;
    const ts: number[] = [];
    for (let i = 0; i < 15; i++) { const s = Date.now(); await c.query('SELECT 1'); ts.push(Date.now() - s); }
    await c.end();
    ts.sort((a, b) => a - b);
    const median = ts[Math.floor(ts.length / 2)];
    console.log(`[db] ${e.DB_HOST}: connect ${connectMs} ms, SELECT 1 median ${median} ms, max ${ts[ts.length - 1]} ms` + (median > 300 ? '  <-- SLOW link: timeouts in this run are not code regressions, rerun when the link is faster' : ''));
  } catch (err) {
    console.log(`[db] latency probe failed: ${(err as Error).message}`);
  }
}

/** Prepares <DB_NAME>_test (migrations + DB-user grants) once per test run. Requires DB_* env (see .env.example). */
export default async function globalSetup(): Promise<void> {
  if (!process.env.DB_HOST || !process.env.DB_NAME) {
    throw new Error('Integration tests need a TiDB/MySQL database: set DB_HOST, DB_NAME, DB_OWNER_USER, DB_OWNER_PASSWORD, DB_API_PASSWORD, DB_PLATFORM_PASSWORD');
  }
  await reportDbLatency();
  const cmd = process.env.TEST_DB_RESET === 'true' ? 'reset-test' : 'prepare-test';
  execFileSync(process.execPath, [join(__dirname, '..', '..', '..', 'database', 'dbctl.mjs'), cmd], { stdio: 'inherit', env: process.env });
  process.env.DB_NAME_UNDER_TEST = `${process.env.DB_NAME}_test`;
}
