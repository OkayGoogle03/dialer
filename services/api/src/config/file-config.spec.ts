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
    for (const key of ['DB_API_PASSWORD', 'JWT_ACCESS_SECRET', 'CREDENTIALS_ENCRYPTION_KEY', 'WEBRTC_TURN_USERNAME', 'WEBRTC_TURN_CREDENTIAL', 'WEBRTC_TURN_SECRET']) {
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
    expect(cfg.webrtc).toEqual({ stunUrls: ['stun:stun.l.google.com:19302'], turnUrls: [], turnSecret: undefined, turnTtlSeconds: 86400 });
    const raw = readFileSync(join(__dirname, '..', '..', '..', '..', 'config', 'app.config.json'), 'utf8');
    for (const key of SECRET_KEYS) expect(raw).not.toContain(`"${key}"`);
  });

  it('WebRTC ICE servers come from the environment; only stun:/stuns: and turn:/turns: urls are accepted', () => {
    const cfg = loadConfig(mergeFileConfig({ APP_ENV: 'development', ...secrets, WEBRTC_STUN_URLS: 'stun:a.example:3478, http://evil.example, stuns:b.example:5349', WEBRTC_TURN_URLS: 'turn:t.example:3478?transport=udp,javascript:x', WEBRTC_TURN_SECRET: 's3cret' }));
    expect(cfg.webrtc).toEqual({ stunUrls: ['stun:a.example:3478', 'stuns:b.example:5349'], turnUrls: ['turn:t.example:3478?transport=udp'], turnSecret: 's3cret', turnTtlSeconds: 86400 });
  });

  it('short-lived TURN credentials: WEBRTC_TURN_SECRET and its lifetime come from the environment only, and the secret is refused in the config file', () => {
    const cfg = loadConfig(mergeFileConfig({ APP_ENV: 'development', ...secrets, WEBRTC_TURN_URLS: 'turn:t.example:3478', WEBRTC_TURN_SECRET: 'shared-secret', WEBRTC_TURN_TTL_SECONDS: '3600' }));
    expect(cfg.webrtc.turnSecret).toBe('shared-secret');
    expect(cfg.webrtc.turnTtlSeconds).toBe(3600);
    expect(SECRET_KEYS.has('WEBRTC_TURN_SECRET')).toBe(true);
    // out-of-range lifetimes are rejected (5 minutes to 7 days)
    expect(() => loadConfig(mergeFileConfig({ APP_ENV: 'development', ...secrets, WEBRTC_TURN_TTL_SECONDS: '10' }))).toThrow(/WEBRTC_TURN_TTL_SECONDS/);
  });

  it('TURN urls without WEBRTC_TURN_SECRET are refused, and a fixed TURN username/password is not supported (browsers only get short-lived credentials)', () => {
    expect(() => loadConfig(mergeFileConfig({ APP_ENV: 'development', ...secrets, WEBRTC_TURN_URLS: 'turn:t.example:3478' }))).toThrow(/WEBRTC_TURN_URLS needs WEBRTC_TURN_SECRET/);
    expect(() => loadConfig(mergeFileConfig({ APP_ENV: 'development', ...secrets, WEBRTC_TURN_URLS: 'turn:t.example:3478', WEBRTC_TURN_USERNAME: 'u', WEBRTC_TURN_CREDENTIAL: 'c' }))).toThrow(/WEBRTC_TURN_URLS needs WEBRTC_TURN_SECRET/);
    const cfg = loadConfig(mergeFileConfig({ APP_ENV: 'development', ...secrets, WEBRTC_TURN_USERNAME: 'u', WEBRTC_TURN_CREDENTIAL: 'c' }));
    expect(JSON.stringify(cfg.webrtc)).not.toMatch(/"u"|"c"/);
  });

  it('the production section is blank on purpose, so a forgotten value fails loudly instead of using the dev database', () => {
    expect(() => loadConfig(mergeFileConfig({ APP_ENV: 'production', ...secrets }))).toThrow(/DB_HOST is required[\s\S]*DB_NAME is required/);
  });
});
