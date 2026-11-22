import { JwtService } from '@nestjs/jwt';
import { normalizeIp, throttleTracker } from './throttler.guard';

const jwt = new JwtService({ secret: 'unit-test-secret-unit-test-secret-1234', signOptions: { algorithm: 'HS256' } });
const verify = (t: string) => jwt.verifyAsync(t, { algorithms: ['HS256'] });
const USER = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

describe('normalizeIp', () => {
  it('groups IPv6 by /64 and leaves IPv4 alone', () => {
    expect(normalizeIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:db8:1:2:ffff::9')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:db8::5')).toBe('2001:db8:0:0::/64');
  });
});

describe('rate-limit tracker', () => {
  it('counts a valid token per user, so agents behind one address do not share a limit', async () => {
    const a = await jwt.signAsync({ sub: USER, tid: TENANT }, { expiresIn: 60 });
    const b = await jwt.signAsync({ sub: '33333333-3333-4333-8333-333333333333', tid: TENANT }, { expiresIn: 60 });
    const one = await throttleTracker({ headers: { authorization: `Bearer ${a}` }, ip: '203.0.113.9' }, verify);
    const two = await throttleTracker({ headers: { authorization: `Bearer ${b}` }, ip: '203.0.113.9' }, verify);
    expect(one).toBe(`u:${USER}`);
    expect(two).not.toBe(one);
  });

  it('falls back to the address for missing, malformed, expired, forged or wrongly signed tokens', async () => {
    const ip = '198.51.100.4';
    expect(await throttleTracker({ headers: {}, ip }, verify)).toBe(`ip:${ip}`);
    expect(await throttleTracker({ headers: { authorization: 'Bearer not.a.jwt' }, ip }, verify)).toBe(`ip:${ip}`);
    expect(await throttleTracker({ headers: { authorization: 'Basic abc' }, ip }, verify)).toBe(`ip:${ip}`);
    const expired = await jwt.signAsync({ sub: USER, tid: TENANT }, { expiresIn: -10 });
    expect(await throttleTracker({ headers: { authorization: `Bearer ${expired}` }, ip }, verify)).toBe(`ip:${ip}`);
    // a token signed with another secret claims to be the victim: it must not be able to use (or exhaust) the victim's bucket
    const other = new JwtService({ secret: 'another-secret-another-secret-another-1', signOptions: { algorithm: 'HS256' } });
    const forged = await other.signAsync({ sub: USER, tid: TENANT }, { expiresIn: 60 });
    expect(await throttleTracker({ headers: { authorization: `Bearer ${forged}` }, ip }, verify)).toBe(`ip:${ip}`);
    // a valid signature but a subject that is not a UUID is not trusted either
    const odd = await jwt.signAsync({ sub: 'admin', tid: TENANT }, { expiresIn: 60 });
    expect(await throttleTracker({ headers: { authorization: `Bearer ${odd}` }, ip }, verify)).toBe(`ip:${ip}`);
  });
});
