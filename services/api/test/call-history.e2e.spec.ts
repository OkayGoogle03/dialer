import { resultKind } from '../src/softphone/call-history';
import { bearer, nextIp, provision, RUN, startApp, TestApp, token } from './support/harness';
import { post, put } from './support/fixtures';

const A = `ch-a-${RUN}`;
const B = `ch-b-${RUN}`;
const PW = 'call-history-pass-123';

describe('Call history: received and dialled calls with details (TiDB)', () => {
  let t: TestApp;
  let admin: string;
  let other: string;
  let one: string;
  let two: string;
  const acct: Record<string, string> = {};

  const history = async (tok: string, query = '') => (await t.http.get(`/api/v1/call-history${query}`).set(bearer(tok)).set('X-Forwarded-For', nextIp()).expect(200)).body;
  const patch = (tok: string, id: string, body: Record<string, unknown>) => t.http.patch(`/api/v1/softphone/calls/${id}`).set(bearer(tok)).set('X-Forwarded-For', nextIp()).send(body);
  const incoming = async (tok: string, accountId: string, from: string, extra: Record<string, unknown> = {}) => (await post(t.http, tok, '/softphone/calls/incoming', { accountId, from, ...extra })).callId as string;

  beforeAll(async () => {
    t = await startApp();
    await provision(t.platformDb, A, `admin@${A}.test`, PW);
    await provision(t.platformDb, B, `admin@${B}.test`, PW);
    admin = await token(t.http, A, `admin@${A}.test`, PW);
    other = await token(t.http, B, `admin@${B}.test`, PW);
    const ids: Record<string, string> = {};
    for (const n of ['one', 'two']) ids[n] = (await post(t.http, admin, '/users', { email: `${n}@${A}.test`, displayName: n === 'one' ? 'Asha' : 'Bala', password: 'longenough123', roles: ['agent'] })).id;
    one = await token(t.http, A, `one@${A}.test`, 'longenough123');
    two = await token(t.http, A, `two@${A}.test`, 'longenough123');
    const server = (await post(t.http, admin, '/call-servers', { name: 'History PBX', host: '10.0.0.31', port: 8089 })).id;
    await put(t.http, admin, `/call-servers/${server}`, { status: 'active' });
    for (const [n, sip] of [['one', '4001'], ['two', '4002']] as const) acct[n] = (await post(t.http, admin, '/softphone-accounts', { userId: ids[n], callServerId: server, sipId: sip, password: 'sip-secret-123' })).id;
  }, 120_000);

  afterAll(async () => { await t?.close(); });

  it('records a received call that was answered, one that was missed and one that was rejected', async () => {
    const answered = await incoming(two, acct.two!, '4001', { callerName: 'Name from the call server' });
    await patch(two, answered, { status: 'answered' }).expect(200);
    await new Promise((r) => setTimeout(r, 2100)); // the talk time in the note must match the stored times
    expect((await patch(two, answered, { status: 'completed', cause: 'Caller hung up' }).expect(200)).body.outcome).toMatchObject({ status: 'success' });
    await patch(two, await incoming(two, acct.two!, '4999'), { status: 'failed', cause: 'Caller cancelled (Canceled)' }).expect(200);
    await patch(two, await incoming(two, acct.two!, '4001'), { status: 'failed', cause: 'Rejected by agent' }).expect(200);
    const h = await history(two, '?tab=received');
    expect(h.counts).toEqual({ all: 3, received: 3, dialled: 0 });
    expect(h.items.map((c: { result: string }) => c.result)).toEqual(['rejected', 'missed', 'answered']);
    expect(h.items[2]).toMatchObject({ direction: 'received', otherNumber: '4001', otherName: 'Asha', myExtension: '4002', callServerName: 'History PBX', agentName: 'Bala' });
    expect(h.items[2].answeredAt).toBeTruthy();
    expect(h.items[2].talkSeconds).toBeGreaterThanOrEqual(2);
    expect(Number(/after ([0-9]+)s/.exec(h.items[2].note)?.[1])).toBeGreaterThanOrEqual(2);
    expect(h.items[1]).toMatchObject({ otherNumber: '4999', otherName: null, talkSeconds: null, note: 'Missed call' });
  });

  it('the three tabs split dialled from received, with filters and paging', async () => {
    const placed = (await t.http.post('/api/v1/softphone/calls').set(bearer(two)).set('X-Forwarded-For', nextIp()).send({ accountId: acct.two, destination: '4001' }).expect(201)).body;
    await patch(two, placed.callId, { status: 'ringing' }).expect(200);
    await patch(two, placed.callId, { status: 'completed', cause: 'No answer within 30 s (ring limit)' }).expect(200);
    const dialled = await history(two, '?tab=dialled');
    expect(dialled.counts).toEqual({ all: 4, received: 3, dialled: 1 });
    expect(dialled.items).toHaveLength(1);
    expect(dialled.items[0]).toMatchObject({ direction: 'dialled', otherNumber: '4001', otherName: 'Asha', myExtension: '4002', entered: '4001', result: 'no_answer', fromCallList: false });
    expect((await history(two)).items).toHaveLength(4);
    expect((await history(two, '?search=4999')).total).toBe(1);
    expect((await history(two, '?search=asha')).total).toBe(0); // the stored call has no such text: names are looked up, the search covers number, caller name, process and agent
    expect((await history(two, '?limit=3&offset=3')).items).toHaveLength(1);
    expect((await history(two, `?from=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`)).total).toBe(0);
    for (const bad of ['?tab=other', '?limit=1000', '?from=yesterday']) await t.http.get(`/api/v1/call-history${bad}`).set(bearer(two)).expect(400);
  });

  it('agents see only their own calls, an administrator sees all, and another tenant sees none', async () => {
    expect((await history(one)).total).toBe(0);
    const all = await history(admin);
    expect(all).toMatchObject({ everyone: true, total: 4 });
    expect((await history(admin, '?search=bala')).total).toBe(4);
    expect((await history(other)).total).toBe(0);
  });

  it('only the owner can report on a call, and only for their own account', async () => {
    const id = await incoming(two, acct.two!, '4001');
    await patch(one, id, { status: 'answered' }).expect(404);
    await post(t.http, one, '/softphone/calls/incoming', { accountId: acct.two, from: '4001' }, 404);
    await post(t.http, two, '/softphone/calls/incoming', { accountId: acct.two, from: 'not a number!' }, 400);
  });

  it('an unfinished call is "in progress" at first and "no final result" much later', () => {
    const base = { direction: 'inbound', status: 'ringing', answered: false, cause: null, outcome: null };
    expect(resultKind({ ...base, ageMs: 60_000 })).toBe('in_progress');
    expect(resultKind({ ...base, ageMs: 3 * 60 * 60_000 })).toBe('unknown');
  });
});
