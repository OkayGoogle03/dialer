import ExcelJS from 'exceljs';
import { ACCOUNT_HEADERS, DISPLAY_NAME_HEADER, MAX_ACCOUNT_ROWS, parseAccountWorkbook } from '../src/softphone/account-import';
import { bearer, nextIp, ownerConnection, provision, RUN, startApp, TestApp, token } from './support/harness';
import { post, put } from './support/fixtures';
import { makeWorkbook } from './support/xlsx';

const A = `si-a-${RUN}`;
const B = `si-b-${RUN}`;
const PW = 'sip-import-pass-123';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEAD = [...ACCOUNT_HEADERS, DISPLAY_NAME_HEADER];

describe('Bulk import of agent to SIP account mappings (TiDB)', () => {
  let t: TestApp;
  let a: string;
  let b: string;
  let agent: string;
  const ids: Record<string, string> = {};
  const mail = (n: string) => `${n}@${A}.test`;

  const upload = (tok: string, buf: Buffer, query = '') =>
    t.http.post(`/api/v1/softphone-accounts/import${query}`).set(bearer(tok)).set('X-Forwarded-For', nextIp()).attach('file', buf, { filename: 'map.xlsx', contentType: XLSX });
  const accounts = async (tok: string) => (await t.http.get('/api/v1/softphone-accounts').set(bearer(tok)).expect(200)).body.items as { userEmail: string; sipId: string }[];

  beforeAll(async () => {
    t = await startApp();
    await provision(t.platformDb, A, `admin@${A}.test`, PW);
    await provision(t.platformDb, B, `admin@${B}.test`, PW);
    a = await token(t.http, A, `admin@${A}.test`, PW);
    b = await token(t.http, B, `admin@${B}.test`, PW);
    for (const n of ['one', 'two', 'three', 'four']) ids[n] = (await post(t.http, a, '/users', { email: mail(n), displayName: n, password: 'longenough123', roles: ['agent'] })).id;
    agent = await token(t.http, A, mail('one'), 'longenough123');
    const server = await post(t.http, a, '/call-servers', { name: 'Import PBX', host: '10.0.0.9', port: 8089 });
    await put(t.http, a, `/call-servers/${server.id}`, { status: 'active' });
    await post(t.http, a, '/softphone-accounts', { userId: ids.four, callServerId: server.id, sipId: '4004', password: 'existing-secret-4' });
  }, 90_000);

  afterAll(async () => { await t?.close(); });

  const file = () => makeWorkbook([
    [mail('one').toUpperCase(), 'import pbx', '4001', 'secret-one-111', 'Agent One'],
    [mail('two'), 'Import PBX', 4002, 'secret-two-222', ''],
    [mail('three'), 'Import PBX', '4001', 'secret-three-333', ''], // SIP ID already used by row 2
    [mail('two'), 'Import PBX', '4009', 'secret-dup-999', ''], // same agent twice
    [mail('four'), 'Import PBX', '4004', 'ignored-secret', ''], // already linked
    [mail('four'), 'Import PBX', '4444', 'secret-four-444', ''], // agent already has another SIP ID there
    ['nobody@example.test', 'Import PBX', '4010', 'secret-x', ''],
    [mail('three'), 'No Such PBX', '4011', 'secret-y', ''],
    [mail('three'), 'Import PBX', 'bad id!', 'secret-z', ''],
    [mail('three'), 'Import PBX', '4012', '', ''],
  ], HEAD);

  it('offers a template, and only to someone who manages call servers', async () => {
    const res = await t.http.get('/api/v1/softphone-accounts/import-template').set(bearer(a)).buffer(true)
      .parse((r, done) => { const parts: Buffer[] = []; r.on('data', (d: Buffer) => parts.push(d)); r.on('end', () => done(null, Buffer.concat(parts))); }).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ExcelJS.Buffer);
    expect((wb.worksheets[0]!.getRow(1).values as unknown[]).slice(1)).toEqual(HEAD);
    await t.http.get('/api/v1/softphone-accounts/import-template').set(bearer(agent)).expect(403);
    await upload(agent, await file(), '?dryRun=false').expect(403);
  });

  it('a check (the default) reports every row and saves nothing', async () => {
    const body = (await upload(a, await file()).expect(200)).body;
    expect(body).toMatchObject({ dryRun: true, total: 10, toCreate: 2, created: 0, unchanged: 1, invalid: 7 });
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['create', 'create', 'error', 'error', 'unchanged', 'error', 'error', 'error', 'error', 'error']);
    expect(body.results[2].message).toMatch(/Row 2 already uses this SIP ID/);
    expect(body.results[3].message).toMatch(/Row 3 already links this agent/);
    expect(JSON.stringify(body)).not.toContain('secret-');
    expect(await accounts(a)).toHaveLength(1);
  });

  it('import creates the valid rows with encrypted passwords, changes nothing else, and is safe to repeat', async () => {
    const body = (await upload(a, await file(), '?dryRun=false').expect(200)).body;
    expect(body).toMatchObject({ dryRun: false, toCreate: 2, created: 2, unchanged: 1, invalid: 7 });
    expect(JSON.stringify(body)).not.toContain('secret-');
    expect((await accounts(a)).map((x) => `${x.userEmail}:${x.sipId}`).sort()).toEqual([`${mail('four')}:4004`, `${mail('one')}:4001`, `${mail('two')}:4002`]);
    const c = await ownerConnection();
    const [rows] = await c.query(`SELECT user_id, sip_secret_encrypted FROM softphone_accounts WHERE user_id IN (?)`, [[ids.one, ids.two]]);
    const [audit] = await c.query(`SELECT metadata FROM audit_logs WHERE action = 'softphone_account.imported' ORDER BY created_at DESC LIMIT 1`);
    await c.end();
    for (const r of rows as { sip_secret_encrypted: string }[]) { expect(r.sip_secret_encrypted).toMatch(/^v1\./); expect(r.sip_secret_encrypted).not.toContain('secret-'); }
    expect(JSON.stringify(audit)).not.toContain('secret-');
    // the imported agent receives their own password, exactly as in the file
    const cfg = (await t.http.get('/api/v1/softphone/config').set(bearer(agent)).expect(200)).body;
    expect(cfg.accounts.map((x: { password: string }) => x.password)).toEqual(['secret-one-111']);
    const again = (await upload(a, await file(), '?dryRun=false').expect(200)).body;
    expect(again).toMatchObject({ created: 0, unchanged: 3 });
    expect(await accounts(a)).toHaveLength(3);
  });

  it('another tenant cannot link these users or use this call server', async () => {
    const body = (await upload(b, await file(), '?dryRun=false').expect(200)).body;
    expect(body).toMatchObject({ created: 0, invalid: 10 });
    expect(await accounts(b)).toHaveLength(0);
  });

  it('refuses a missing file, a non-Excel file and wrong headers', async () => {
    await t.http.post('/api/v1/softphone-accounts/import').set(bearer(a)).set('X-Forwarded-For', nextIp()).expect(400);
    await upload(a, Buffer.from('agent,server,sip,password')).expect(400);
    await upload(a, await makeWorkbook([['x', 'y', 'z', 'w']], ['Email', 'Server', 'User', 'Pass'])).expect(400);
    await upload(a, await file(), '?dryRun=yes').expect(400);
  });

  it('the sheet reader limits the row count and rejects formulas', async () => {
    const many = Array.from({ length: MAX_ACCOUNT_ROWS + 1 }, (_, i) => [`a${i}@x.test`, 'PBX', String(i), 'p', '']);
    await expect(parseAccountWorkbook(await makeWorkbook(many, HEAD))).rejects.toThrow(/More than 500 rows/);
    const [row] = await parseAccountWorkbook(await makeWorkbook([['a@x.test', 'PBX', '1', { formula: '1+1' }, '']], HEAD));
    expect(row!.error).toMatch(/Formulas are not allowed/);
    await expect(parseAccountWorkbook(await makeWorkbook([], HEAD))).rejects.toThrow(/no data rows/);
  });
});
