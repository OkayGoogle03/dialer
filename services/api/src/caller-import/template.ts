import ExcelJS from 'exceljs';
import { HEADERS, MAX_DATA_ROWS } from './excel-format';

export interface TemplateLists { processes: string[]; providers: string[]; callServers: string[] }

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
const MAX_LIST = 1000;

/**
 * Builds Project_Dialer_Caller_Template.xlsx.
 *  Sheet 1 "Callers": five fixed, locked, frozen headers; data cells unlocked and formatted as text; dropdown suggestions from the
 *    tenant's existing master data (warning-style, so new names are still accepted and proposed during import).
 *  Sheet 2 "Instructions": column help + sample records (kept out of the data sheet so samples are never imported by accident).
 *  Sheet 3 "Existing Master Data": names only. No credentials, no internal identifiers, no hidden content.
 * Worksheet protection (no password) only prevents accidental edits; the backend always validates headers itself.
 */
export async function buildTemplate(lists: TemplateLists): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Project Dialer';
  wb.created = new Date();

  const ws = wb.addWorksheet('Callers', { views: [{ state: 'frozen', ySplit: 1 }] });
  const widths = [26, 26, 18, 12, 22];
  ws.columns = HEADERS.map((h, i) => ({ key: `c${i}`, width: widths[i], style: { numFmt: '@', protection: { locked: false } } }));
  const head = ws.getRow(1);
  HEADERS.forEach((h, i) => {
    const cell = head.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.numFmt = '@';
    cell.protection = { locked: true };
  });
  head.height = 22;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADERS.length } };

  const ref = wb.addWorksheet('Existing Master Data');
  ref.columns = [{ width: 30 }, { width: 30 }, { width: 30 }];
  ref.addRow(['Processes', 'Service Providers', 'Call Servers']).font = { bold: true };
  const cols: [string[], string][] = [[lists.processes, 'A'], [lists.providers, 'B'], [lists.callServers, 'C']];
  const sliced = cols.map(([l]) => l.slice(0, MAX_LIST));
  const max = Math.max(0, ...sliced.map((l) => l.length));
  for (let i = 0; i < max; i++) ref.addRow(sliced.map((l) => l[i] ?? null));
  ref.addRow([]);
  ref.addRow(['These are your current records, for reference. You may also type new names; they are proposed for creation during import preview.']);

  const targets: [string, number][] = [['A', 0], ['B', 1], ['E', 2]];
  for (const [col, idx] of targets) {
    const n = sliced[idx].length;
    if (!n) continue; // empty master data: no dropdown (nothing to suggest)
    const refCol = ['A', 'B', 'C'][idx];
    (ws as any).dataValidations.add(`${col}2:${col}${MAX_DATA_ROWS + 1}`, {
      type: 'list', allowBlank: true, showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Not in master data yet',
      error: 'This value does not exist yet. You can keep it; it will be proposed for creation (as Pending) during import preview.',
      formulae: [`'Existing Master Data'!$${refCol}$2:$${refCol}$${n + 1}`],
    });
  }

  const ins = wb.addWorksheet('Instructions');
  ins.columns = [{ width: 22 }, { width: 70 }, { width: 22 }, { width: 14 }, { width: 22 }];
  ins.addRow(['Project Dialer - Caller Excel Import']).font = { bold: true, size: 14 };
  ins.addRow([]);
  ins.addRow(['Column', 'What to enter']).font = { bold: true };
  ins.addRow(['Process Name', 'The outbound process this caller assignment belongs to (for example a campaign or carrier line of business). Required.']);
  ins.addRow(['Service Provider', 'The SIP service provider that carries the calls. Required. Technical SIP settings are configured separately in Providers/Trunks.']);
  ins.addRow(['DID', 'The caller-ID / originating number, digits only (6-15 digits, no spaces). Keep it as text so leading zeros are preserved. Required.']);
  ins.addRow(['Prefix', 'The dial prefix applied to destination numbers for this assignment, digits only (for example 91). Required.']);
  ins.addRow(['Call Server', 'The Asterisk call server used for these calls (its name as shown under Call Servers). Required.']);
  ins.addRow([]);
  ins.addRow(['Rules']).font = { bold: true };
  for (const line of [
    'Do not rename, reorder, add or delete columns. The header row is locked to prevent accidental edits; the server also validates it.',
    `Maximum ${MAX_DATA_ROWS} records per file. Only the .xlsx format is supported (not .xls).`,
    'Do not use formulas; enter plain values.',
    'This sheet only provides business assignments. It cannot create SIP credentials, server logins or carrier ownership proof.',
    'Names that do not exist yet are proposed as new records with status "Pending"; you review and approve them before anything is created.',
    'New providers, DIDs and call servers stay inactive until their technical settings are configured and verified separately.',
  ]) ins.addRow([`- ${line}`]);
  ins.addRow([]);
  ins.addRow(['Sample records (examples only - do not copy unless they match your setup)']).font = { bold: true };
  ins.addRow([...HEADERS]).font = { bold: true };
  ins.addRow(['Tata', 'Tata', '2233445511', '91', 'Asterisk-01']);
  ins.addRow(['Airtel', 'Airtel', '2233445522', '91', 'Asterisk-01']);
  ins.addRow(['Jio', 'Jio', '2233445533', '91', 'Asterisk-02']);
  ins.addRow(['Vodafone', 'Vodafone Idea', '2233445544', '91', 'Asterisk-02']);

  // Data sheet: users may enter/edit data, sort and filter, and insert/delete data rows, but not touch the header cells or columns.
  await ws.protect('', {
    selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true, insertRows: true, deleteRows: true,
    sort: true, autoFilter: true, formatCells: false, insertColumns: false, deleteColumns: false, insertHyperlinks: false,
  });
  await ref.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  await ins.protect('', { selectLockedCells: true, selectUnlockedCells: true });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
