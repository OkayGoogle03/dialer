import { createHmac } from 'node:crypto';
import { bearer, provision, RUN, startApp, TestApp, token } from './support/harness';
import { post, put } from './support/fixtures';

const A = `turn-${RUN}`;
const PW = 'turn-test-pass-123';
const TURN_SECRET = `turn-shared-secret-${RUN}-never-for-browsers`;

describe('TURN credentials through the authenticated softphone config endpoint (TiDB)', () => {
  let t: TestApp;
  let ag1: string;
  let ag2: string;
  let ag1Id: string;
  let ag2Id: string;
  const issued: string[] = []; // every credential handed out by the tests below

  beforeAll(async () => {
    t = await startApp({ webrtc: { turnUrls: ['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349?transport=tcp'], turnSecret: TURN_SECRET, turnTtlSeconds: 3600 } });
    await provision(t.platformDb, A, `admin@${A}.test`, PW);
    const admin = await token(t.http, A, `admin@${A}.test`, PW);
    ag1Id = (await post(t.http, admin, '/users', { email: `ag1@${A}.test`, displayName: 'Ag1', password: 'longenough123', roles: ['agent'] })).id;
    ag2Id = (await post(t.http, admin, '/users', { email: `ag2@${A}.test`, displayName: 'Ag2', password: 'longenough123', roles: ['agent'] })).id;
    ag1 = await token(t.http, A, `ag1@${A}.test`, 'longenough123');
    ag2 = await token(t.http, A, `ag2@${A}.test`, 'longenough123');
    const server = await post(t.http, admin, '/call-servers', { name: 'PBX-T', host: 'pbx.example.test', port: 8089 });
    await put(t.http, admin, `/call-servers/${server.id}`, { status: 'active' });
    await post(t.http, admin, '/softphone-accounts', { userId: ag1Id, callServerId: server.id, sipId: '2001', password: 'sip-secret-one-123' });
    await post(t.http, admin, '/softphone-accounts', { userId: ag2Id, callServerId: server.id, sipId: '2002', password: 'sip-secret-two-123' });
  }, 90_000);

  afterAll(async () => { await t?.close(); });

  const cfg = (tok?: string) => { const r = t.http.get('/api/v1/softphone/config'); return tok ? r.set(bearer(tok)) : r; };
  const turnOf = (body: { iceServers: { urls: string[]; username?: string; credential?: string }[] }) => body.iceServers.find((s) => s.urls.some((u) => u.startsWith('turn')))!;

  it('requires a signed-in agent: no token, no TURN credentials', async () => {
    const r = await cfg().expect(401);
    expect(JSON.stringify(r.body)).not.toMatch(/turn|credential|username/i);
  });

  it('a signed-in agent gets short-lived, derived credentials; the shared secret is never in the response', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await cfg(ag1).expect(200);
    const turn = turnOf(res.body);
    const [expiry, user] = turn.username!.split(':');
    expect(user).toBe(ag1Id);
    expect(Number(expiry)).toBeGreaterThanOrEqual(before + 3600 - 5);
    expect(Number(expiry)).toBeLessThanOrEqual(before + 3600 + 30);
    expect(turn.credential).toBe(createHmac('sha1', TURN_SECRET).update(turn.username!).digest('base64'));
    issued.push(turn.credential!, turn.username!);
    expect(turn.urls).toEqual(['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349?transport=tcp']);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(JSON.stringify(res.body)).not.toContain(TURN_SECRET);
    expect(JSON.stringify(res.headers)).not.toContain(TURN_SECRET);
  });

  it('every agent gets their own credential (derived from their own user id)', async () => {
    const t1 = turnOf((await cfg(ag1).expect(200)).body);
    const t2 = turnOf((await cfg(ag2).expect(200)).body);
    expect(t2.username!.split(':')[1]).toBe(ag2Id);
    issued.push(t1.credential!, t2.credential!, t2.username!);
    expect(t1.credential).not.toBe(t2.credential);
  });

  it('neither the secret nor any issued credential is written to the API log', () => {
    const text = JSON.stringify(t.logs.lines);
    expect(t.logs.lines.length).toBeGreaterThan(0); // the requests above were logged...
    expect(text).not.toContain(TURN_SECRET);   // ...but never the secret,
    expect(text).not.toMatch(/"credential"/);   // never the credential field,
    expect(text).not.toContain('turnSecret');
    expect(issued.length).toBeGreaterThanOrEqual(5);
    for (const v of issued) expect(text).not.toContain(v); // none of the credentials actually issued appears in the log
  });
});
