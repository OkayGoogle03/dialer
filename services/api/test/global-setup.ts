import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Prepares <DB_NAME>_test (migrations + DB-user grants) once per test run. Requires DB_* env (see .env.example). */
export default function globalSetup(): void {
  if (!process.env.DB_HOST || !process.env.DB_NAME) {
    throw new Error('Integration tests need a TiDB/MySQL database: set DB_HOST, DB_NAME, DB_OWNER_USER, DB_OWNER_PASSWORD, DB_API_PASSWORD, DB_PLATFORM_PASSWORD');
  }
  const cmd = process.env.TEST_DB_RESET === 'true' ? 'reset-test' : 'prepare-test';
  execFileSync(process.execPath, [join(__dirname, '..', '..', '..', 'database', 'dbctl.mjs'), cmd], { stdio: 'inherit', env: process.env });
  process.env.DB_NAME_UNDER_TEST = `${process.env.DB_NAME}_test`;
}
