import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { makeWorkbook } from '../../test/support/xlsx';
import { buildErrorReportCsv, csvCell } from './error-report';
import { HEADERS, ImportFileError, MAX_DATA_ROWS, parseCallerWorkbook } from './excel-format';
import { buildTemplate } from './template';

const expectFileError = async (p: Promise<unknown>, code: string, msg?: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(ImportFileError);
  expect(e.code).toBe(code);
  if (msg) expect(e.message).toMatch(msg);
};

describe('Excel template', () => {
  it('has exactly the five headers in order, frozen, with locked headers and unlocked data cells', async () => {
    const buf = await buildTemplate({ processes: ['Tata'], providers: ['Tata', 'Airtel'], callServers: [] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0];
    expect(ws.name).toBe('Callers');
    expect([1, 2, 3, 4, 5].map((c) => ws.getRow(1).getCell(c).value)).toEqual([...HEADERS]);
    expect(ws.columnCount).toBe(5);
    expect(ws.getRow(1).getCell(6).value).toBeNull();
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(ws.getRow(1).getCell(1).protection?.locked ?? true).toBe(true); // locked is the OOXML default, omitted on write
    // data cells: column style is unlocked
    expect(ws.getColumn(1).style.protection?.locked).toBe(false);
    expect((ws as unknown as { sheetProtection?: { sheet?: boolean } }).sheetProtection?.sheet).toBe(true);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Callers', 'Existing Master Data', 'Instructions']);
  });

  it('protection forbids column edits but allows data rows (checked in the raw XML)', async () => {
    const zip = await JSZip.loadAsync(await buildTemplate({ processes: [], providers: [], callServers: [] }));
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    const tag = xml.match(/<sheetProtection[^>]*>/)![0];
    expect(tag).toMatch(/sheet="1"/);
    expect(tag).not.toMatch(/deleteColumns="0"/);
    expect(tag).not.toMatch(/insertColumns="0"/);
    expect(tag).not.toMatch(/formatCells="0"/);
    expect(xml).toMatch(/<pane[^>]*state="frozen"/);
    expect(xml).toMatch(/<autoFilter ref="A1:E1"/);
  });

  it('adds dropdown suggestions only from existing master data, never hardcoded names', async () => {
    const withData = await buildTemplate({ processes: ['Alpha'], providers: ['Beta'], callServers: ['Gamma'] });
    const xml = await (await JSZip.loadAsync(withData)).file('xl/worksheets/sheet1.xml')!.async('string');
    expect(xml).toMatch(/dataValidation[^>]*sqref="A2:A5001"/);
    expect(xml).toMatch(/sqref="B2:B5001"/);
    expect(xml).toMatch(/sqref="E2:E5001"/);
    expect(xml).toMatch(/errorStyle="warning"/);
    const empty = await buildTemplate({ processes: [], providers: [], callServers: [] });
    expect(await (await JSZip.loadAsync(empty)).file('xl/worksheets/sheet1.xml')!.async('string')).not.toMatch(/dataValidation/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(empty as unknown as ExcelJS.Buffer);
    const notes: string[] = [];
    wb.getWorksheet('Existing Master Data')!.eachRow((r) => notes.push(String(r.getCell(1).value ?? '')));
    expect(notes.some((n) => n.startsWith('These are your current records'))).toBe(true);
  });

  it('a freshly downloaded blank template parses as an empty file', async () => {
    await expect(parseCallerWorkbook(await buildTemplate({ processes: [], providers: [], callServers: [] }))).resolves.toEqual({ rows: [], emptyRows: 0 });
  });
});

describe('Excel parsing', () => {
  it('reads rows (numbers and text), ignores fully empty rows and counts them', async () => {
    const buf = await makeWorkbook([['Tata', 'Tata', 2233445511, 91, 'AST-01'], [null, null, null, null, null], ['Jio', 'Jio', '2233445533', '91', 'AST-02']]);
    const r = await parseCallerWorkbook(buf);
    expect(r.emptyRows).toBe(1);
    expect(r.rows.map((x) => [x.rowNumber, x.did, x.prefix])).toEqual([[2, '2233445511', '91'], [4, '2233445533', '91']]);
  });

  it.each([
    ['renamed header', ['Process Name', 'Provider', 'DID', 'Prefix', 'Call Server'], /column B: expected "Service Provider", found "Provider"/],
    ['reordered headers', ['Service Provider', 'Process Name', 'DID', 'Prefix', 'Call Server'], /column A: expected "Process Name"/],
    ['missing column', ['Process Name', 'Service Provider', 'DID', 'Prefix'], /column E: expected "Call Server", found "\(empty\)"/],
    ['duplicated column', ['Process Name', 'Service Provider', 'DID', 'DID', 'Call Server'], /column D: expected "Prefix", found "DID"/],
    ['header with trailing space', ['Process Name ', 'Service Provider', 'DID', 'Prefix', 'Call Server'], /column A/],
    ['wrong case', ['process name', 'Service Provider', 'DID', 'Prefix', 'Call Server'], /column A/],
  ])('rejects %s without silently mapping it', async (_n, headers, msg) => {
    await expectFileError(parseCallerWorkbook(await makeWorkbook([['a', 'b', '123456', '91', 'c']], headers as string[])), 'INVALID_HEADERS', msg);
  });

  it('rejects additional columns (in the header or in data rows)', async () => {
    await expectFileError(parseCallerWorkbook(await makeWorkbook([], [...HEADERS, 'Notes'])), 'EXTRA_COLUMNS');
    await expectFileError(parseCallerWorkbook(await makeWorkbook([['a', 'b', '123456', '91', 'c', 'extra']])), 'EXTRA_COLUMNS', /Row 2/);
  });

  it('rejects non-xlsx content: random bytes, legacy .xls (OLE2), CSV text, corrupt zip', async () => {
    await expectFileError(parseCallerWorkbook(Buffer.from('Process Name,Service Provider\nA,B\n')), 'INVALID_FORMAT');
    await expectFileError(parseCallerWorkbook(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])), 'INVALID_FORMAT', /\.xls/);
    await expectFileError(parseCallerWorkbook(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not really a zip')])), 'INVALID_FORMAT');
    await expectFileError(parseCallerWorkbook(Buffer.alloc(0)), 'INVALID_FORMAT');
  });

  it('flags formula and non-text cells per row instead of evaluating them', async () => {
    const buf = await makeWorkbook([['Tata', 'Tata', { formula: '1+1', result: 2 }, '91', 'AST-01'], ['Tata', 'Tata', '2233445511', new Date(), 'AST-01']]);
    const r = await parseCallerWorkbook(buf);
    expect(r.rows[0].cellErrors).toEqual([{ field: 'DID', message: 'Formulas are not allowed; enter the value itself' }]);
    expect(r.rows[1].cellErrors[0].field).toBe('Prefix');
  });

  it(`enforces the ${MAX_DATA_ROWS}-record limit and handles a large valid file`, async () => {
    const ok = Array.from({ length: MAX_DATA_ROWS }, (_, i) => [`P${i % 40}`, `S${i % 10}`, String(1000000000 + i), '91', `C${i % 4}`]);
    const started = Date.now();
    const parsed = await parseCallerWorkbook(await makeWorkbook(ok));
    expect(parsed.rows).toHaveLength(MAX_DATA_ROWS);
    expect(Date.now() - started).toBeLessThan(15_000);
    await expectFileError(parseCallerWorkbook(await makeWorkbook([...ok, ['P', 'S', '9999999999', '91', 'C']])), 'TOO_MANY_ROWS');
  }, 60_000);
});

describe('error report (CSV injection safe)', () => {
  it('neutralises formula-leading values and escapes quotes', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    for (const lead of ['+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(lead).startsWith(`"'`)).toBe(true);
    expect(csvCell('plain "q"')).toBe('"plain ""q"""');
    expect(csvCell(null)).toBe('""');
  });

  it('writes a BOM, headers and one line per problem row', () => {
    const csv = buildErrorReportCsv([{ rowNumber: 3, processName: '=cmd|calc', serviceProvider: 'A', did: '1', prefix: '9', callServer: 'C', status: 'invalid', errors: [{ code: 'INVALID_DID', message: 'Invalid DID: use 6-15 digits.' }] }]);
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines[0]).toBe('"Row","Process Name","Service Provider","DID","Prefix","Call Server","Status","Error Codes","Error Messages"');
    expect(lines[1]).toContain(`"'=cmd|calc"`);
    expect(lines).toHaveLength(2);
  });
});
