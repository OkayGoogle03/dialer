/**
 * Provision a tenant (or the platform tenant + first super admin) from the command line.
 *   PROVISION_ADMIN_PASSWORD=... pnpm --filter @dialer/api provision -- --slug acme --name "Acme" \
 *     --email admin@acme.test --admin-name "Acme Admin" [--plan starter] [--platform]
 * Uses the dialer_platform DB user. The password is read from env, never argv.
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { hashPassword } from '../common/crypto/password';
import { loadConfig } from '../config/env';
import { PlatformDatabase } from '../database/database';
import { createPool } from '../database/mysql';
import { OutboxService } from '../events/outbox.service';
import { provisionTenant } from '../platform/provisioning';

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, 'admin-name': { type: 'string' },
      plan: { type: 'string', default: 'starter' }, platform: { type: 'boolean', default: false },
    },
  });
  for (const k of ['slug', 'name', 'email', 'admin-name'] as const) if (!values[k]) throw new Error(`--${k} is required`);
  const pw = process.env.PROVISION_ADMIN_PASSWORD ?? '';
  if (pw.length < 12 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) throw new Error('PROVISION_ADMIN_PASSWORD must be >= 12 chars with a letter and a digit');
  const config = loadConfig();
  const db = new PlatformDatabase(createPool(config.db, config.db.platformUser, config.db.platformPassword, 1));
  try {
    const r = await db.withPlatform(async (tx) => provisionTenant(tx, new OutboxService(), {
      slug: values.slug!, name: values.name!, planKey: values.plan!, adminEmail: values.email!, adminName: values['admin-name']!,
      adminPasswordHash: await hashPassword(pw), isPlatform: values.platform,
    }));
    console.log(`tenant provisioned: ${values.slug} (${r.tenantId})${values.platform ? ' [platform tenant, admin is super admin]' : ''}`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
