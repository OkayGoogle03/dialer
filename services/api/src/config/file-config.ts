import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Settings that may never be stored in the committed config file. */
export const SECRET_KEYS = new Set([
  'DB_API_PASSWORD', 'DB_PLATFORM_PASSWORD', 'DB_OWNER_PASSWORD', 'DB_OWNER_USER', 'JWT_ACCESS_SECRET', 'CREDENTIALS_ENCRYPTION_KEY',
  'PROVISION_ADMIN_PASSWORD', 'NATS_URL', 'REDIS_URL', 'WEBRTC_TURN_USERNAME', 'WEBRTC_TURN_CREDENTIAL',
]);

type Env = Record<string, string | undefined>;

/** repo root: <root>/services/api/{src|dist}/config -> four levels up (same depth for ts-node and the compiled build). */
const DEFAULT_FILE = join(__dirname, '..', '..', '..', '..', 'config', 'app.config.json');

export function selectEnvironment(env: Env): 'development' | 'preview' | 'production' {
  const v = env.APP_ENV ?? env.VERCEL_ENV;
  if (v === 'production' || v === 'preview' || v === 'development') return v;
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

/**
 * Config-server style defaults: values from config/app.config.json (sections `defaults` + the selected environment) fill in
 * anything the real environment does not set. Real environment variables always win; blank ones count as unset.
 * Secrets are refused loudly so they cannot end up in git. A missing file is fine (everything then comes from the environment).
 */
export function mergeFileConfig(env: Env = process.env, file: string = env.APP_CONFIG_FILE ?? DEFAULT_FILE): Env {
  if (!existsSync(file)) return env;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Invalid configuration: ${file} is not valid JSON (${(e as Error).message})`);
  }
  const fromFile: Record<string, string> = {};
  for (const section of ['defaults', selectEnvironment(env)]) {
    const values = doc[section];
    if (values === undefined) continue;
    if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error(`Invalid configuration: section "${section}" in ${file} must be an object`);
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) throw new Error(`Invalid configuration: ${k} is a secret and must not be stored in ${file}; set it in the host environment`);
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'object') throw new Error(`Invalid configuration: ${k} in ${file} must be a string, number or boolean`);
      fromFile[k] = String(v);
    }
  }
  const merged: Env = { ...fromFile };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') merged[k] = v;
  return merged;
}
