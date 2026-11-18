import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './env';
import { mergeFileConfig, SECRET_KEYS, selectEnvironment } from './file-config';

const write = (doc: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'app.config.json');
  writeFileSync(f, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return f;
};
const secrets = { DB_API_PASSWORD: 'p', DB_PLATFORM_PASSWORD: 'q', JWT_ACCESS_SECRET: 'k'.repeat(32), CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') };

describe('config file (config-server style)', () => {
  it('fills defaults + the selected environment; real environment wins; blanks count as unset', () => {
    const file = write({ defaults: { DB_PORT: 4000, LOG_LEVEL: 'info' }, production: { DB_HOST: 'prod.db', DB_NAME: 'p' }, preview: { DB_HOST: 'prev.db' } });
    const m = mergeFileConfig({ VERCEL_ENV: 'production', LOG_LEVEL: 'debug', DB_NAME: '' }, file);
    expect(m).toMatchObject({ DB_PORT: '4000', DB_HOST: 'prod.db', DB_NAME: 'p', LOG_LEVEL: 'debug' });
    expect(mergeFileConfig({ VERCEL_ENV: 'preview' }, file).DB_HOST).toBe('prev.db');
    expect(mergeFileConfig({ APP_ENV: 'production', VERCEL_ENV: 'preview' }, file).DB_HOST).toBe('prod.db');
  });

  it('selects the environment from APP_ENV, VERCEL_ENV or NODE_ENV', () => {
    expect(selectEnvironment({ NODE_ENV: 'production' })).toBe('production');
    expect(selectEnvironment({ NODE_ENV: 'development' })).toBe('development');
    expect(selectEnvironment({ NODE_ENV: 'production', VERCEL_ENV: 'preview' })).toBe('preview');
    expect(selectEnvironment({ NODE_ENV: 'test' })).toBe('development');
  });

  it('refuses secrets in the file, and bad structure', () => {
    for (const key of ['DB_API_PASSWORD', 'JWT_ACCESS_SECRET', 'CREDENTIALS_ENCRYPTION_KEY']) {
      expect(() => mergeFileConfig({}, write({ defaults: { [key]: 'x' } }))).toThrow(/is a secret and must not be stored/);
    }
    expect(() => mergeFileConfig({}, write('{ nope'))).toThrow(/not valid JSON/);
    expect(() => mergeFileConfig({}, write({ defaults: [] }))).toThrow(/must be an object/);
    expect(() => mergeFileConfig({}, write({ defaults: { DB_HOST: { a: 1 } } }))).toThrow(/must be a string, number or boolean/);
  });

  it('a missing file is fine', () => {
    expect(mergeFileConfig({ A: '1' }, join(tmpdir(), 'does-not-exist.json'))).toEqual({ A: '1' });
  });

  it('the committed config/app.config.json is valid, holds no secrets and, with the four secrets set, produces a complete config', () => {
    const merged = mergeFileConfig({ APP_ENV: 'development', ...secrets });
    const cfg = loadConfig(merged);
    expect(cfg.db.host).toBeTruthy();
    expect(cfg.db.name).toBe('dev_dialer');
    expect(cfg.db.tls).toBe(true);
    const raw = readFileSync(join(__dirname, '..', '..', '..', '..', 'config', 'app.config.json'), 'utf8');
    for (const key of SECRET_KEYS) expect(raw).not.toContain(`"${key}"`);
  });

  it('the production section is blank on purpose, so a forgotten value fails loudly instead of using the dev database', () => {
    expect(() => loadConfig(mergeFileConfig({ APP_ENV: 'production', ...secrets }))).toThrow(/DB_HOST is required[\s\S]*DB_NAME is required/);
  });
});
