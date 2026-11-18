import { hashPassword, verifyPassword } from './password';
import { parseRefreshToken } from '../../auth/auth.service';
import { loadConfig } from '../../config/env';

describe('password hashing', () => {
  it('verifies correct and rejects wrong passwords', async () => {
    const h = await hashPassword('s3cret-passphrase');
    expect(h.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('s3cret-passphrase', h)).toBe(true);
    expect(await verifyPassword('s3cret-passphrasf', h)).toBe(false);
  });

  it('produces unique salts and rejects malformed hashes', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$99999999$8$1$AA==$AA==')).toBe(false);
  });
});

describe('refresh token parsing', () => {
  it('accepts well-formed tokens only', () => {
    const t = '6f1c1d0e-3c6a-4a51-9a2e-0d6b7c1f8e21';
    const secret = 'a'.repeat(43);
    expect(parseRefreshToken(`${t}.${t}.${secret}`)).toEqual({ tenantId: t, tokenId: t, secret });
    expect(parseRefreshToken(`${t}.${t}`)).toBeNull();
    expect(parseRefreshToken(`not-uuid.${t}.${secret}`)).toBeNull();
    expect(parseRefreshToken(`${t}.${t}.short`)).toBeNull();
  });
});

describe('config validation', () => {
  it('requires DB settings and a strong JWT secret; derives prefixed DB user names', () => {
    expect(() => loadConfig({})).toThrow(/JWT_ACCESS_SECRET[\s\S]*CREDENTIALS_ENCRYPTION_KEY[\s\S]*DB_HOST[\s\S]*DB_API_PASSWORD/);
    const ok = { DB_HOST: 'h', DB_NAME: 'd', DB_API_PASSWORD: 'p', DB_PLATFORM_PASSWORD: 'q', DB_USER_PREFIX: 'abc.', JWT_ACCESS_SECRET: 'k'.repeat(32), CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), CORS_ORIGINS: 'a, b' };
    expect(() => loadConfig({ ...ok, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
    const c = loadConfig(ok);
    expect(c.corsOrigins).toEqual(['a', 'b']);
    expect(c.db).toMatchObject({ apiUser: 'abc.dialer_api', platformUser: 'abc.dialer_platform', port: 4000, tls: false });
  });
});
