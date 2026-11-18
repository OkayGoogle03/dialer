import { renderPjsipTrunk, trunkEndpointName } from '../telephony/pjsip-config';
import { SecretsService } from '../common/crypto/secrets.service';
import { DEFAULT_DIAL_PLAN } from '../master-data/processes';
import { Candidate, isRetryableSip, isUncertainSip, normalizeDestination, operationalReasons, orderCandidates, weightedOrder } from './routing';

const ok = (over: Partial<Candidate> = {}): Candidate => ({
  assignmentId: 'A1', assignmentStatus: 'active', prefix: '91',
  process: { id: 'P', name: 'P', status: 'active', strategy: 'priority', dialPlan: DEFAULT_DIAL_PLAN, maxConcurrent: 10, defaultProviderId: null },
  provider: { id: 'S1', name: 'S1', status: 'active', priority: 100, weight: 100, max: 10, maxAttempts: 2 },
  trunk: { id: 'T1', name: 'T1', status: 'active', verification: 'verified', health: 'healthy', circuit: 'closed', priority: 100, weight: 100, max: 10 },
  did: { id: 'D1', did: '2233445511', callerId: '2233445511', status: 'active', verification: 'verified', max: 5 },
  server: { id: 'C1', name: 'C1', status: 'active', connection: 'connected', ariUrl: 'http://x/ari', ariUsername: 'u', hasSecret: true, max: 10 },
  ...over,
});

describe('operational checks never treat unverified resources as usable', () => {
  it('fully verified route is operational', () => expect(operationalReasons(ok())).toEqual([]));
  it.each([
    ['provider pending', { provider: { ...ok().provider, status: 'pending_configuration' } }, 'provider_not_active'],
    ['trunk unverified', { trunk: { ...ok().trunk, verification: 'pending' } }, 'trunk_not_verified'],
    ['trunk pending status', { trunk: { ...ok().trunk, status: 'pending_configuration' } }, 'trunk_not_verified'],
    ['trunk down', { trunk: { ...ok().trunk, health: 'down' } }, 'trunk_unhealthy'],
    ['circuit open', { trunk: { ...ok().trunk, circuit: 'open' } }, 'trunk_unhealthy'],
    ['DID unverified', { did: { ...ok().did, verification: 'pending' } }, 'did_not_verified'],
    ['server not connected', { server: { ...ok().server, connection: 'unknown' } }, 'server_not_connected'],
    ['server without ARI config', { server: { ...ok().server, ariUrl: null } }, 'server_not_configured'],
    ['process disabled', { process: { ...ok().process, status: 'disabled' } }, 'process_disabled'],
    ['no trunk', { trunk: { ...ok().trunk, id: '' } }, 'no_trunk'],
  ] as [string, Partial<Candidate>, string][])('%s', (_n, over, reason) => expect(operationalReasons(ok(over))).toContain(reason));
});

describe('destination normalisation (prefix + dial plan)', () => {
  const plan = DEFAULT_DIAL_PLAN;
  it('prepends the assignment prefix to national numbers and strips the trunk zero', () => {
    expect(normalizeDestination('9876543210', '91', plan)).toEqual({ ok: true, dialed: '919876543210' });
    expect(normalizeDestination('09876543210', '91', plan)).toEqual({ ok: true, dialed: '919876543210' });
    expect(normalizeDestination('98765 43210', '91', plan)).toEqual({ ok: true, dialed: '919876543210' });
    expect(normalizeDestination('09876543210', '91', { ...plan, stripLeadingZeros: false })).toEqual({ ok: true, dialed: '9109876543210' });
  });
  it('treats +E.164 and 00-prefixed numbers as already international', () => {
    expect(normalizeDestination('+919876543210', '44', plan)).toEqual({ ok: true, dialed: '919876543210' });
    expect(normalizeDestination('00919876543210', '44', plan)).toEqual({ ok: true, dialed: '919876543210' });
  });
  it('rejects invalid, too short/long, blocked and not-allow-listed destinations', () => {
    expect(normalizeDestination('abc123', '91', plan)).toMatchObject({ ok: false, code: 'INVALID_DESTINATION' });
    expect(normalizeDestination('12', '91', plan)).toMatchObject({ ok: false });
    expect(normalizeDestination('1'.repeat(19), '91', plan)).toMatchObject({ ok: false, code: 'INVALID_DESTINATION' });
    expect(normalizeDestination('9876543210', '91', { ...plan, blockedDestinationPrefixes: ['9198'] })).toMatchObject({ ok: false, code: 'DESTINATION_NOT_ALLOWED' });
    expect(normalizeDestination('9876543210', '91', { ...plan, allowedDestinationPrefixes: ['44'] })).toMatchObject({ ok: false, code: 'DESTINATION_NOT_ALLOWED' });
    expect(normalizeDestination('9876543210', '91', { ...plan, allowedDestinationPrefixes: ['91'] })).toMatchObject({ ok: true });
  });
});

describe('ordering / selection', () => {
  const mk = (id: string, priority: number, weight: number) => ok({ provider: { ...ok().provider, id, name: id, priority, weight }, did: { ...ok().did, did: id } });
  it('priority: lowest priority number first; default provider wins; weight breaks ties', () => {
    const cs = [mk('B', 20, 50), mk('A', 10, 10), mk('C', 10, 90)];
    expect(orderCandidates(cs, 'priority', null).map((c) => c.provider.id)).toEqual(['C', 'A', 'B']);
    expect(orderCandidates(cs, 'priority', 'B').map((c) => c.provider.id)).toEqual(['B', 'C', 'A']);
  });
  it('weighted: follows the weights statistically and puts zero-weight providers last', () => {
    const cs = [mk('heavy', 100, 90), mk('light', 100, 10), mk('never', 100, 0)];
    let seed = 42;
    const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const firsts: Record<string, number> = { heavy: 0, light: 0, never: 0 };
    for (let i = 0; i < 4000; i++) firsts[orderCandidates(cs, 'weighted', null, rng)[0].provider.id]++;
    expect(firsts.never).toBe(0);
    expect(firsts.heavy / 4000).toBeGreaterThan(0.85);
    expect(firsts.heavy / 4000).toBeLessThan(0.95);
    expect(weightedOrder([1, 2, 3], (x) => x, () => 0.5)).toHaveLength(3);
  });
});

describe('SIP failure classes', () => {
  it('retries only gateway failures; busy/rejected/forbidden/auth are not retried; 408 is uncertain', () => {
    for (const c of [500, 502, 503, 504]) expect(isRetryableSip(c)).toBe(true);
    for (const c of [401, 403, 404, 407, 480, 486, 487, 488, 603]) expect(isRetryableSip(c)).toBe(false);
    expect(isUncertainSip(408)).toBe(true);
    expect(isRetryableSip(408)).toBe(false);
  });
});

describe('PJSIP config generation', () => {
  const trunk = { id: '6f1c1d0e-3c6a-4a51-9a2e-0d6b7c1f8e21', host: 'sip.carrier.example', port: 5061, transport: 'tls' as const, authMode: 'registration' as const, username: 'acct01', authId: null, password: 'S3cret-pw', realm: 'carrier.example', outboundProxy: null, registrationExpirySeconds: 300, codecs: ['ulaw', 'alaw'] };
  it('renders endpoint, aor, auth and registration sections', () => {
    const cfg = renderPjsipTrunk(trunk);
    const ep = trunkEndpointName(trunk.id);
    expect(ep).toBe('trunk_6f1c1d0e3c6a4a519a2e0d6b7c1f8e21');
    expect(cfg).toContain(`[${ep}]\ntype=endpoint`);
    expect(cfg).toContain('allow=ulaw,alaw');
    expect(cfg).toContain('type=registration');
    expect(cfg).toContain('password=S3cret-pw');
  });
  it('masks the password for previews and uses identify for IP trunks', () => {
    expect(renderPjsipTrunk(trunk, { maskSecrets: true })).not.toContain('S3cret-pw');
    const ip = renderPjsipTrunk({ ...trunk, authMode: 'ip', username: null, password: null });
    expect(ip).toContain('type=identify');
    expect(ip).not.toContain('type=registration');
  });
  it('refuses values that could inject config sections or lines', () => {
    expect(() => renderPjsipTrunk({ ...trunk, host: 'a.example\n[evil]' })).toThrow(/invalid host/);
    expect(() => renderPjsipTrunk({ ...trunk, username: 'x\ny=1' })).toThrow(/invalid username/);
    expect(() => renderPjsipTrunk({ ...trunk, password: 'ok\n[evil]\ntype=endpoint' })).toThrow(/invalid password/);
    expect(() => renderPjsipTrunk({ ...trunk, codecs: ['ulaw', 'evil;x'] })).toThrow(/invalid codec/);
    expect(() => renderPjsipTrunk({ ...trunk, id: 'not-a-uuid' })).toThrow(/invalid trunk id/);
  });
});

describe('credential encryption', () => {
  const s = new SecretsService({ credentialsKey: Buffer.alloc(32, 9) } as never);
  it('round-trips, uses a random IV and authenticates', () => {
    const a = s.encrypt('p@ss'), b = s.encrypt('p@ss');
    expect(a).not.toBe(b);
    expect(a).not.toContain('p@ss');
    expect(s.decrypt(a)).toBe('p@ss');
    expect(() => s.decrypt(a.slice(0, -2) + 'AA')).toThrow();
    expect(() => new SecretsService({ credentialsKey: Buffer.alloc(32, 1) } as never).decrypt(a)).toThrow();
    expect(() => s.decrypt('plain')).toThrow(/unsupported/);
  });
});
