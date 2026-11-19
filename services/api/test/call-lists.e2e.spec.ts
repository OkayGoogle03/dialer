import ExcelJS from 'exceljs';
import { bearer, nextIp, ownerConnection, provision, RUN, startApp, TestApp, token } from './support/harness';
import { post } from './support/fixtures';
import { makeWorkbook } from './support/xlsx';
import { LIST_HEADERS } from '../src/call-lists/call-lists';

const A = `cl-a-${RUN}`;
const B = `cl-b-${RUN}`;
const PW = 'calllist-pass-123';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('Excel call lists: dynamic call server / SIP account / prefix / numbers, live status, Excel export (TiDB)', () => {
  let t: TestApp;
  let a: string;
  let b: string;
  let ag1: string;
  let ag2: string;
  let ag1Id: string;
  let listId: string;
  let items: { id: string; row: number; status: string; phone: string; processName: string | null }[];

  const upload = (tok: string, buf: Buffer, qs = '') =>
    t.http.post(`/api/v1/call-lists/import${qs}`).set(bearer(tok)).set('X-Forwarded-For', nextIp()).attach('file', buf, { filename: 'calls.xlsx', contentType: XLSX });
  const getItems = async (tok: string) => (await t.http.get(`/api/v1/call-lists/${listId}/items`).set(bearer(tok)).expect(200)).body;

  beforeAll(async () => {
    t = await startApp();
    await provision(t.platformDb, A, `admin@${A}.test`, PW);
    await provision(t.platformDb, B, `admin@${B}.test`, PW);
    a = await token(t.http, A, `admin@${A}.test`, PW);
    b = await token(t.http, B, `admin@${B}.test`, PW);
    ag1Id = (await post(t.http, a, '/users', { email: `ag1@${A}.test`, displayName: 'Ag1', password: 'longenough123', roles: ['agent'] })).id;
    await post(t.http, a, '/users', { email: `ag2@${A}.test`, displayName: 'Ag2', password: 'longenough123', roles: ['agent'] });
    ag1 = await token(t.http, A, `ag1@${A}.test`, 'longenough123');
    ag2 = await token(t.http, A, `ag2@${A}.test`, 'longenough123');
  }, 60_000);

  afterAll(async () => { await t?.close(); });

  it('template has the five exact headers; wrong headers and bad files are rejected', async () => {
    const tpl = await t.http.get('/api/v1/call-lists/template').set(bearer(a)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.body as ExcelJS.Buffer);
    expect((wb.worksheets[0].getRow(1).values as string[]).slice(1)).toEqual([...LIST_HEADERS, 'Process Name']);
    const wrong = await makeWorkbook([['1', '2', '3', '4', '5']], ['Server', 'SIP', 'Pass', 'Prefix', 'Phone']);
    expect((await upload(a, wrong).expect(400)).body.error.message).toMatch(/headers/i);
    await upload(a, Buffer.from('not an excel file')).expect(400);
    await upload(a, await makeWorkbook([], LIST_HEADERS)).expect(400);
    // an old five-column file is still accepted by the header check (it fails only because it has no rows)
    expect((await upload(a, await makeWorkbook([], LIST_HEADERS)).expect(400)).body.error.message).toMatch(/no data rows/);
    const sixth = await makeWorkbook([], [...LIST_HEADERS, 'Wrong']);
    expect((await upload(a, sixth).expect(400)).body.error.message).toMatch(/headers/i);
  });

  it('only managers import; the import creates the call server and the agent\'s SIP account and keeps bad rows with reasons', async () => {
    const rows = [
      ['10.20.30.40', '2001', 'excel-sip-secret-1', '91', '9876543210', 'Sales Outbound'],
      ['10.20.30.40', '2001', 'excel-sip-secret-1', '91', '+14155550100'],
      ['10.20.30.40', '2002', 'other-secret', '91', '9876543211'], // second SIP ID for the same agent+server
      ['10.20.30.40', '2001', 'excel-sip-secret-1', '91', 'abc'],  // bad phone
      ['not a host!', '2001', 'x', '91', '9876543212'],            // bad IP
    ];
    await upload(ag1, await makeWorkbook(rows, [...LIST_HEADERS, 'Process Name']), `?userId=${ag1Id}`).expect(403);
    const res = (await upload(a, await makeWorkbook(rows, [...LIST_HEADERS, 'Process Name']), `?userId=${ag1Id}&name=Morning%20batch`).expect(201)).body;
    expect(res).toMatchObject({ total: 5, valid: 2, invalid: 3, createdServers: 1 });
    expect(res.errors.map((e: { message: string }) => e.message).join('|')).toMatch(/already uses SIP ID 2001/);
    listId = res.id;

    const servers = (await t.http.get('/api/v1/call-servers').set(bearer(a)).expect(200)).body.items;
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ host: '10.20.30.40', status: 'active' });
    const accts = (await t.http.get('/api/v1/softphone-accounts').set(bearer(a)).expect(200)).body;
    expect(JSON.stringify(accts)).not.toContain('excel-sip-secret-1');
    expect(accts.items[0]).toMatchObject({ sipId: '2001', userId: ag1Id });
    const c = await ownerConnection();
    const [r] = await c.query(`SELECT sip_secret_encrypted FROM softphone_accounts WHERE user_id = ?`, [ag1Id]);
    const [lr] = await c.query(`SELECT COUNT(*) AS n FROM call_list_items WHERE list_id = ? AND (result LIKE '%excel-sip-secret%' OR sip_id LIKE '%secret%')`, [listId]);
    await c.end();
    expect((r as { sip_secret_encrypted: string }[])[0].sip_secret_encrypted).toMatch(/^v1\./);
    expect(Number((lr as { n: number }[])[0].n)).toBe(0); // the password is not stored in the list rows
    // the agent's softphone gets the dynamic details
    const cfg = (await t.http.get('/api/v1/softphone/config').set(bearer(ag1)).expect(200)).body;
    expect(cfg.accounts[0]).toMatchObject({ sipId: '2001', password: 'excel-sip-secret-1' });
    expect(cfg.accounts[0].callServer.host).toBe('10.20.30.40');
  });

  it('lists are private to the agent and the managers; tenant isolated', async () => {
    expect((await t.http.get('/api/v1/call-lists').set(bearer(ag1)).expect(200)).body.items).toHaveLength(1);
    expect((await t.http.get('/api/v1/call-lists').set(bearer(ag2)).expect(200)).body.items).toHaveLength(0);
    expect((await t.http.get('/api/v1/call-lists').set(bearer(a)).expect(200)).body.items[0]).toMatchObject({ name: 'Morning batch', processNames: ['Sales Outbound'], total: 5, invalid: 3, counts: { pending: 2, invalid: 3 } });
    await t.http.get(`/api/v1/call-lists/${listId}/items`).set(bearer(ag2)).expect(404);
    await t.http.get(`/api/v1/call-lists/${listId}/items`).set(bearer(b)).expect(404);
    await t.http.get(`/api/v1/call-lists/${listId}/export`).set(bearer(b)).expect(404);
    const body = await getItems(ag1);
    items = body.items;
    expect(items.find((i: { phone: string }) => i.phone === '9876543210')).toMatchObject({ processName: 'Sales Outbound' });
    expect(items.find((i: { phone: string }) => i.phone === '+14155550100')?.processName ?? null).toBeNull();
    expect(body.counts).toEqual({ pending: 2, invalid: 3 });
  });

  it('calling a row applies the row prefix and the status follows the call live', async () => {
    const first = items.find((i) => i.phone === '9876543210')!;
    const intl = items.find((i) => i.phone === '+14155550100')!;
    const bad = items.find((i) => i.status === 'invalid')!;
    await t.http.post(`/api/v1/call-lists/${listId}/items/${first.id}/call`).set(bearer(a)).expect(403); // not the owner
    await t.http.post(`/api/v1/call-lists/${listId}/items/${bad.id}/call`).set(bearer(ag1)).expect(400);
    const placed = (await t.http.post(`/api/v1/call-lists/${listId}/items/${first.id}/call`).set(bearer(ag1)).expect(201)).body;
    expect(placed).toMatchObject({ dialed: '919876543210', prefix: '91', target: 'sip:919876543210@10.20.30.40' });
    await t.http.post(`/api/v1/call-lists/${listId}/items/${first.id}/call`).set(bearer(ag1)).expect(409); // already calling
    expect((await getItems(ag1)).items.find((i: { id: string }) => i.id === first.id)).toMatchObject({ status: 'calling', dialed: '919876543210', attempts: 1 });
    for (const s of ['ringing', 'answered']) {
      await t.http.patch(`/api/v1/softphone/calls/${placed.callId}`).set(bearer(ag1)).send({ status: s }).expect(200);
      expect((await getItems(ag1)).items.find((i: { id: string }) => i.id === first.id).status).toBe(s);
    }
    await t.http.patch(`/api/v1/softphone/calls/${placed.callId}`).set(bearer(ag1)).send({ status: 'completed' }).expect(200);
    // the process name is saved with the call and shown in the agent's call history
    expect((await t.http.get('/api/v1/softphone/calls').set(bearer(ag1)).expect(200)).body.items.find((c: { id: string }) => c.id === placed.callId)).toMatchObject({ processName: 'Sales Outbound' });
    expect((await getItems(ag1)).items.find((i: { id: string }) => i.id === first.id)).toMatchObject({ status: 'success', result: expect.stringMatching(/Call answered and completed/) });

    const p2 = (await t.http.post(`/api/v1/call-lists/${listId}/items/${intl.id}/call`).set(bearer(ag1)).expect(201)).body;
    expect(p2.dialed).toBe('14155550100');
    await t.http.patch(`/api/v1/softphone/calls/${p2.callId}`).set(bearer(ag1)).send({ status: 'failed', cause: 'Busy Here', sipCode: 486 }).expect(200);
    expect((await getItems(ag1)).items.find((i: { id: string }) => i.id === intl.id)).toMatchObject({ status: 'success', result: expect.stringMatching(/busy or on another call/), sipCode: 486 });
    // a failed row can be retried
    const retry = (await t.http.post(`/api/v1/call-lists/${listId}/items/${intl.id}/call`).set(bearer(ag1)).expect(201)).body;
    // ring limit: the softphone cancels after the configured ring time and reports the call as ended without answer
    expect((await t.http.get('/api/v1/softphone/config').set(bearer(ag1)).expect(200)).body.ringTimeoutSeconds).toBe(5);
    await t.http.patch(`/api/v1/softphone/calls/${retry.callId}`).set(bearer(ag1)).send({ status: 'ringing' }).expect(200);
    await t.http.patch(`/api/v1/softphone/calls/${retry.callId}`).set(bearer(ag1)).send({ status: 'completed', cause: 'No answer within 5 s (ring limit)' }).expect(200);
    expect((await getItems(ag1)).items.find((i: { id: string }) => i.id === intl.id)).toMatchObject({ status: 'success', result: expect.stringMatching(/rang but the user did not answer/), attempts: 2 });
    // a phone that is switched off / unreachable never rings: Not success with the reason
    const third = (await t.http.post(`/api/v1/call-lists/${listId}/items/${intl.id}/call`).set(bearer(ag1)).expect(201)).body;
    await t.http.patch(`/api/v1/softphone/calls/${third.callId}`).set(bearer(ag1)).send({ status: 'failed', cause: 'Temporarily Unavailable', sipCode: 480 }).expect(200);
    expect((await getItems(ag1)).items.find((i: { id: string }) => i.id === intl.id)).toMatchObject({ status: 'not_success', result: expect.stringMatching(/switched off or not reachable/), sipCode: 480, attempts: 3 });
  });

  it('exports an Excel with every row and its outcome, without any SIP password', async () => {
    const res = await t.http.get(`/api/v1/call-lists/${listId}/export`).set(bearer(ag1)).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(res.headers['content-disposition']).toMatch(/Morning_batch_results\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as ExcelJS.Buffer);
    const ws = wb.worksheets[0];
    const head = (ws.getRow(1).values as string[]).slice(1);
    expect(head).toEqual(expect.arrayContaining(['Call Server IP', 'SIP ID', 'Prefix', 'Phone Number', 'Process Name', 'Status', 'Note', 'Duration (s)']));
    expect(ws.rowCount).toBe(6);
    const text = JSON.stringify(ws.getSheetValues());
    expect(text).not.toContain('excel-sip-secret-1');
    expect(text).toContain('Success');
    expect(text).toContain('Not success');
    expect(text).toContain('Sales Outbound');
    expect(text).toContain('Invalid row');
    expect(text).toContain('Phone Number must be');
  });

  it('deleting a list removes its rows', async () => {
    await t.http.delete(`/api/v1/call-lists/${listId}`).set(bearer(b)).expect(404);
    await t.http.delete(`/api/v1/call-lists/${listId}`).set(bearer(a)).expect(204);
    expect((await t.http.get('/api/v1/call-lists').set(bearer(a)).expect(200)).body.items).toHaveLength(0);
    const c = await ownerConnection();
    const [r] = await c.query(`SELECT COUNT(*) AS n FROM call_list_items WHERE list_id = ?`, [listId]);
    await c.end();
    expect(Number((r as { n: number }[])[0].n)).toBe(0);
  });
});
