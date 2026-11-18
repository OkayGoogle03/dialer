import { emptySnapshot, evaluateRows, MasterSnapshot } from './evaluate';
import type { ParsedRow } from './excel-format';

const row = (n: number, p: string, s: string, d: string, x: string, c: string): ParsedRow => ({ rowNumber: n, processName: p, serviceProvider: s, did: d, prefix: x, callServer: c, cellErrors: [] });

function fullSnapshot(): MasterSnapshot {
  const s = emptySnapshot();
  s.processes.set('tata', { id: 'P1', name: 'Tata', status: 'active' });
  s.providers.set('tata', { id: 'S1', name: 'Tata', status: 'active' });
  s.providers.set('airtel', { id: 'S2', name: 'Airtel', status: 'active' });
  s.servers.set('ast-01', { id: 'C1', name: 'AST-01', status: 'active' });
  s.dids.set('2233445511', { id: 'D1', providerId: 'S1', status: 'active' });
  s.dids.set('2233445522', { id: 'D2', providerId: 'S2', status: 'active' });
  s.processProvider.add('P1|S1');
  s.processDid.add('P1|D1');
  s.processServer.add('P1|C1');
  return s;
}

describe('caller import evaluation', () => {
  it('empty master database: everything is proposed, nothing is an error', () => {
    const ev = evaluateRows([row(2, 'Tata', 'Tata', '2233445511', '91', 'AST-01'), row(3, 'Airtel', 'Airtel', '2233445522', '91', 'AST-02')], emptySnapshot(), { allowProposals: true });
    expect(ev.results.map((r) => r.status)).toEqual(['needs_master_data', 'needs_master_data']);
    expect(ev.proposals.processes.map((p) => p.name)).toEqual(['Tata', 'Airtel']);
    expect(ev.proposals.providers).toHaveLength(2);
    expect(ev.proposals.callServers).toHaveLength(2);
    expect(ev.proposals.dids.map((d) => [d.name, d.providerName, d.prefix])).toEqual([['2233445511', 'Tata', '91'], ['2233445522', 'Airtel', '91']]);
    expect(ev.proposals.missingLinks).toEqual({ processProvider: 2, processDid: 2, processServer: 2 });
    expect(ev.counts).toMatchObject({ total: 2, valid: 0, needsMasterData: 2, invalid: 0, duplicate: 0 });
  });

  it('the same data with allowProposals=false reports precise missing-master-data errors (nothing is created implicitly)', () => {
    const ev = evaluateRows([row(2, 'Tata', 'Tata', '2233445511', '91', 'AST-01')], emptySnapshot(), { allowProposals: false });
    expect(ev.results[0].status).toBe('invalid');
    expect(ev.results[0].errors.map((e) => e.message)).toEqual(expect.arrayContaining([
      'Process Name does not exist.', 'Service Provider is not configured.', 'Call Server does not exist.', 'DID does not exist.',
    ]));
  });

  it('existing, fully linked data is valid and resolves to ids', () => {
    const ev = evaluateRows([row(2, ' tata ', 'TATA', '2233445511', '+91', 'ast-01')], fullSnapshot(), { allowProposals: false });
    expect(ev.results[0]).toMatchObject({ status: 'valid', resolved: { processId: 'P1', providerId: 'S1', didId: 'D1', serverId: 'C1', prefix: '91' } });
    expect(ev.existing).toEqual({ processes: 1, providers: 1, callServers: 1, dids: 1 });
  });

  it('missing relationships are proposed (preview) or rejected (confirm)', () => {
    const snap = fullSnapshot();
    snap.processProvider.delete('P1|S1');
    const rows = [row(2, 'Tata', 'Tata', '2233445511', '91', 'AST-01')];
    const preview = evaluateRows(rows, snap, { allowProposals: true });
    expect(preview.results[0].status).toBe('needs_master_data');
    expect(preview.proposals.missingLinks.processProvider).toBe(1);
    const confirm = evaluateRows(rows, snap, { allowProposals: false });
    expect(confirm.results[0].errors.map((e) => e.message)).toEqual(['Provider is not assigned to this process.']);
  });

  it('format errors: missing values, invalid DID, invalid prefix, over-long names, formula cells', () => {
    const bad: ParsedRow[] = [
      row(2, '', 'Tata', '2233445511', '91', 'AST-01'),
      row(3, 'Tata', 'Tata', '22-33', '91', 'AST-01'),
      row(4, 'Tata', 'Tata', '2233445511', '9x1', 'AST-01'),
      row(5, 'T'.repeat(101), 'Tata', '2233445511', '91', 'AST-01'),
      { ...row(6, 'Tata', 'Tata', '', '91', 'AST-01'), cellErrors: [{ field: 'DID', message: 'Formulas are not allowed; enter the value itself' }] },
    ];
    const codes = evaluateRows(bad, fullSnapshot(), { allowProposals: true }).results.map((r) => r.errors.map((e) => e.code));
    expect(codes).toEqual([['MISSING_VALUE'], ['INVALID_DID'], ['INVALID_PREFIX'], ['VALUE_TOO_LONG'], ['INVALID_CELL']]);
  });

  it('DID must belong to the selected provider', () => {
    const ev = evaluateRows([row(2, 'Tata', 'Airtel', '2233445511', '91', 'AST-01')], fullSnapshot(), { allowProposals: true });
    expect(ev.results[0].errors.map((e) => e.message)).toEqual(['DID is not assigned to the selected provider.']);
    // an existing DID cannot be claimed by a provider that does not exist yet either
    const ev2 = evaluateRows([row(2, 'Tata', 'Brand New', '2233445511', '91', 'AST-01')], fullSnapshot(), { allowProposals: true });
    expect(ev2.results[0].errors[0].code).toBe('DID_PROVIDER_MISMATCH');
  });

  it('disabled master data is rejected', () => {
    const snap = fullSnapshot();
    snap.providers.set('tata', { id: 'S1', name: 'Tata', status: 'disabled' });
    expect(evaluateRows([row(2, 'Tata', 'Tata', '2233445511', '91', 'AST-01')], snap, { allowProposals: true }).results[0].errors[0].code).toBe('PROVIDER_DISABLED');
  });

  it('duplicates: within the file, against existing assignments; conflicting prefix; DID under two providers', () => {
    const snap = fullSnapshot();
    snap.assignments.add('P1|S1|D1|C1');
    const rows = [
      row(2, 'Tata', 'Tata', '2233445511', '91', 'AST-01'), // existing assignment
      row(3, 'Newp', 'Airtel', '2233445522', '91', 'AST-01'),
      row(4, 'Newp', 'Airtel', '2233445522', '91', 'AST-01'), // duplicate of row 3
      row(5, 'Newp', 'Airtel', '2233445522', '44', 'AST-01'), // same assignment, other prefix
      row(6, 'Other', 'Tata', '5555555555', '91', 'AST-01'),
      row(7, 'Other', 'Airtel', '5555555555', '91', 'AST-01'), // same DID, other provider
    ];
    const ev = evaluateRows(rows, snap, { allowProposals: true });
    expect(ev.results.map((r) => r.status)).toEqual(['duplicate', 'needs_master_data', 'duplicate', 'invalid', 'invalid', 'invalid']);
    expect(ev.results[0].errors[0].code).toBe('DUPLICATE_EXISTING');
    expect(ev.results[2].errors[0].code).toBe('DUPLICATE_IN_FILE');
    expect(ev.results[3].errors[0].code).toBe('CONFLICTING_PREFIX');
    expect(ev.results[4].errors[0].code).toBe('DID_CONFLICT_IN_FILE');
    expect(ev.counts).toMatchObject({ duplicate: 2, invalid: 3, needsMasterData: 1 });
  });

  it('evaluates 5000 rows quickly', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(i + 2, `Process ${i % 50}`, `Provider ${i % 20}`, String(1000000000 + i), '91', `Server ${i % 5}`));
    const started = Date.now();
    const ev = evaluateRows(rows, emptySnapshot(), { allowProposals: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ev.counts.needsMasterData).toBe(5000);
    expect(ev.proposals.processes).toHaveLength(50);
    expect(ev.proposals.dids).toHaveLength(5000);
  });
});
