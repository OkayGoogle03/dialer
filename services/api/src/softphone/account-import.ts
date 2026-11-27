import ExcelJS from 'exceljs';
import { cellText, ImportFileError } from '../caller-import/excel-format';

/** Bulk agent <-> SIP account mapping: one row per link. */
export const ACCOUNT_HEADERS = ['Agent Email', 'Call Server', 'SIP ID', 'SIP Password'] as const;
/** Optional fifth column. */
export const DISPLAY_NAME_HEADER = 'Display Name';
export const ACCOUNT_TEMPLATE_FILENAME = 'SIP_Account_Mapping_Template.xlsx';
export const MAX_ACCOUNT_ROWS = 500;

export interface AccountRow {
  row: number;
  email: string;
  server: string;
  sipId: string;
  password: string;
  displayName: string;
  error?: string;
}

export async function buildAccountTemplate(): Promise<Buffer> {
  const headers = [...ACCOUNT_HEADERS, DISPLAY_NAME_HEADER];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SIP accounts');
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  ws.columns = [{ width: 32 }, { width: 28 }, { width: 16 }, { width: 28 }, { width: 24 }];
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // text format, so Excel keeps leading zeros in SIP IDs and passwords
  for (let c = 1; c <= headers.length; c++) ws.getColumn(c).numFmt = '@';
  const info = wb.addWorksheet('Instructions');
  [
    'One row links one agent to one SIP account. Keep the headers in the first row exactly as they are.',
    'Agent Email: the sign-in email of an active user in the Dialer.',
    'Call Server: the server name exactly as shown on the Call Servers page (capital letters do not matter). It must already exist.',
    'SIP ID / SIP Password: the login already created for this agent on that call server. Importing does not create it on the phone server.',
    'Display Name: optional.',
    `Up to ${MAX_ACCOUNT_ROWS} rows. Existing links are never changed: edit those on the Call Servers page.`,
    'This file holds SIP passwords. Delete it after importing and do not email or share it.',
  ].forEach((t) => info.addRow([t]));
  info.getColumn(1).width = 120;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Reads the sheet and checks each cell's shape. What depends on stored data (users, servers, clashes) is checked by the service. */
export async function parseAccountWorkbook(buf: Buffer): Promise<AccountRow[]> {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) throw new ImportFileError('INVALID_FORMAT', 'The file is not a valid .xlsx workbook.');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ExcelJS.Buffer); } catch { throw new ImportFileError('INVALID_FORMAT', 'The workbook could not be read; it may be corrupted.'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new ImportFileError('EMPTY_FILE', 'The workbook has no worksheets.');
  const head = [1, 2, 3, 4, 5].map((c) => cellText(ws.getRow(1).getCell(c).value).text);
  if (ACCOUNT_HEADERS.some((h, i) => head[i] !== h) || (head[4] !== '' && head[4] !== DISPLAY_NAME_HEADER)) {
    throw new ImportFileError('INVALID_HEADERS', `Invalid headers. The first row must be exactly: ${[...ACCOUNT_HEADERS, DISPLAY_NAME_HEADER].join(' | ')} (${DISPLAY_NAME_HEADER} is optional).`);
  }
  const out: AccountRow[] = [];
  for (let r = 2; r <= Math.min(ws.rowCount, 100_000); r++) {
    const cells = [1, 2, 3, 4, 5].map((c) => cellText(ws.getRow(r).getCell(c).value));
    if (cells.every((c) => c.text === '' && !c.error)) continue;
    if (out.length >= MAX_ACCOUNT_ROWS) throw new ImportFileError('TOO_MANY_ROWS', `More than ${MAX_ACCOUNT_ROWS} rows. Split the file.`);
    const [email, server, sipId, password, displayName] = cells.map((c) => c.text);
    out.push({ row: r, email: email.toLowerCase(), server, sipId, password, displayName, error: cells.find((c) => c.error)?.error });
  }
  if (!out.length) throw new ImportFileError('EMPTY_FILE', 'The file has no data rows.');
  return out;
}
