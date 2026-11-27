import { LIST_HEADERS, PROCESS_HEADER } from '../src/call-lists/call-lists';
import { mergePrefixes } from '../src/softphone/dial-prefixes';
import { bearer, nextIp, provision, RUN, startApp, TestApp, token } from './support/harness';
import { post, put } from './support/fixtures';
import { makeWorkbook } from './support/xlsx';

const A = `dp-a-${RUN}`;
const B = `dp-b-${RUN}`;
const PW = 'dial-prefix-pass-123';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HOST = '10.0.0.21';

describe('Dial prefixes: saved per call server, taken from call lists, applied per call (TiDB)', () => {
  let t: TestApp;
  let admin: string;
  let other: string;
  let one: string;
  let two: string;
  const ids: Record<string, string> = {};
  let serverId: string;
  const acct: Record<string, string> = {};

  const saved = async (tok = admin) => ((await t.http.get('/api/v1/dial-prefixes').set(bearer(tok)).expect(200)).body.items as { prefix: string; label: string | null; source: string }[]).map((p) => `${p.prefix}:${p.label}:${p.source}`);
  const importList = async (userId: string, rows: (string | number)[][]) => {
    const file = await makeWorkbook(rows, [...LIST_HEADERS, PROCESS_HEADER]);
    return (await t.http.post(`/api/v1/call-lists/import?userId=${userId}`).set(bearer(admin)).set('X-Forwarded-For', nextIp()).attach('file', file, { filename: 'calls.xlsx', contentType: XLSX }).expect(201)).body;
  };
  const place = (tok: string, accountId: string, body: Record<string, unknown>) => t.http.post('/api/v1/softphone/calls').set(bearer(tok)).set('X-Forwarded-For', nextIp()).send({ accountId, ...body });

  beforeAll(async () => {
    t = await startApp();
    await provision(t.platformDb, A, `admin@${A}.test`, PW);
    await provision(t.platformDb, B, `admin@${B}.test`, PW);
    admin = await token(t.http, A, `admin@${A}.test`, PW);
    other = await token(t.http, B, `admin@${B}.test`, PW);
    for (const n of ['one', 'two']) ids[n] = (await post(t.http, admin, '/users', { email: `${n}@${A}.test`, displayName: n, password: 'longenough123', roles: ['agent'] })).id;
    one = await token(t.http, A, `one@${A}.test`, 'longenough123');
    two = await token(t.http, A, `two@${A}.test`, 'longenough123');
    serverId = (await post(t.http, admin, '/call-servers', { name: 'Prefix PBX', host: HOST, port: 8089 })).id;
    await put(t.http, admin, `/call-servers/${serverId}`, { status: 'active' });
    for (const [n, sip] of [['one', '4001'], ['two', '4002']] as const) acct[n] = (await post(t.http, admin, '/softphone-accounts', { userId: ids[n], callServerId: serverId, sipId: sip, password: 'sip-secret-123' })).id;
  }, 120_000);

  afterAll(async () => { await t?.close(); });

  it('a manager adds and removes prefixes; bad values, duplicates, agents and other tenants are refused', async () => {
    await post(t.http, admin, '/dial-prefixes', { callServerId: serverId, prefix: '0', label: 'Local' });
    expect(await saved()).toEqual(['0:Local:manual']);
    await post(t.http, admin, '/dial-prefixes', { callServerId: serverId, prefix: '0' }, 409);
    for (const prefix of ['', '12a', '+91', '1234567']) await post(t.http, admin, '/dial-prefixes', { callServerId: serverId, prefix }, 400);
    await t.http.get('/api/v1/dial-prefixes').set(bearer(one)).expect(403);
    await t.http.post('/api/v1/dial-prefixes').set(bearer(one)).send({ callServerId: serverId, prefix: '7' }).expect(403);
    await post(t.http, other, '/dial-prefixes', { callServerId: serverId, prefix: '7' }, 404);
    expect(await saved(other)).toEqual([]);
  });

  it('importing a call list saves its prefixes once, keeping what was already there', async () => {
    const first = await importList(ids.one!, [[HOST, '4001', 'sip-secret-123', '91', '9876500001', 'Sales'], [HOST, '4001', 'sip-secret-123', '91', '9876500002', 'Sales'], [HOST, '4001', 'sip-secret-123', '0', '9876500003', 'Other name'], [HOST, '4001', 'sip-secret-123', '', '9876500004', '']]);
    expect(first).toMatchObject({ valid: 4, savedPrefixes: 1 });
    expect(await saved()).toEqual(['0:Local:manual', '91:Sales:call_list']);
    expect(await importList(ids.two!, [[HOST, '4002', 'sip-secret-123', '55', '9876500001', 'Support']])).toMatchObject({ savedPrefixes: 1 });
    const config = (await t.http.get('/api/v1/softphone/config').set(bearer(one)).expect(200)).body;
    expect(config.dialPrefixes.map((p: { prefix: string }) => p.prefix)).toEqual(['0', '55', '91']);
  });

  it('automatic mode applies the prefix from the agent\'s own call list, and none for a number that is not in it', async () => {
    expect((await place(one, acct.one!, { destination: '98765 00001', autoPrefix: true }).expect(201)).body).toMatchObject({ prefix: '91', dialed: '919876500001' });
    // the same number in another agent's list has another prefix: each agent gets their own
    expect((await place(two, acct.two!, { destination: '9876500001', autoPrefix: true }).expect(201)).body).toMatchObject({ prefix: '55', dialed: '559876500001' });
    expect((await place(two, acct.two!, { destination: '9876500002', autoPrefix: true }).expect(201)).body).toMatchObject({ prefix: '', dialed: '9876500002' });
    expect((await place(one, acct.one!, { destination: '4002', autoPrefix: true }).expect(201)).body).toMatchObject({ prefix: '', dialed: '4002' });
  });

  it('a chosen prefix must be one that is saved for the call server', async () => {
    expect((await place(one, acct.one!, { destination: '12345', prefix: '91' }).expect(201)).body).toMatchObject({ prefix: '91', dialed: '9112345' });
    await place(one, acct.one!, { destination: '12345', prefix: '44' }).expect(400);
    await post(t.http, admin, '/dial-prefixes/delete', { callServerId: serverId, prefix: '91' }, 200);
    await place(one, acct.one!, { destination: '12345', prefix: '91' }).expect(400);
    // call list rows keep their own prefix, so automatic mode still works
    expect((await place(one, acct.one!, { destination: '9876500002', autoPrefix: true }).expect(201)).body).toMatchObject({ prefix: '91' });
  });

  it('caller details give only the name behind an extension on the agent\'s own call server', async () => {
    const who = (tok: string, accountId: string, number: string) => t.http.get(`/api/v1/softphone/caller?accountId=${accountId}&number=${number}`).set(bearer(tok));
    expect((await who(one, acct.one!, '4002').expect(200)).body).toEqual({ name: 'two' });
    expect((await who(one, acct.one!, '4999').expect(200)).body).toEqual({ name: null });
    await who(two, acct.one!, '4002').expect(404); // someone else's account
    await who(other, acct.one!, '4002').expect(404); // another tenant
  });

  it('merging never overwrites a label that was typed in', () => {
    expect(mergePrefixes([{ prefix: '91', label: 'Mine', source: 'manual' }], [{ prefix: '91', label: 'File', source: 'call_list' }, { prefix: 'x', label: null, source: 'call_list' }]))
      .toEqual([{ prefix: '91', label: 'Mine', source: 'manual' }]);
  });
});
