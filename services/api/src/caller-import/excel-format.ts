import ExcelJS from 'exceljs';

/** The five columns, in this exact order. The backend validates them independently of any worksheet protection. */
export const HEADERS = ['Process Name', 'Service Provider', 'DID', 'Prefix', 'Call Server'] as const;
export const TEMPLATE_FILENAME = 'Project_Dialer_Caller_Template.xlsx';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_DATA_ROWS = 5000;
const MAX_SCAN_ROWS = 100_000;

export class ImportFileError extends Error {
  constructor(readonly code: 'INVALID_FORMAT' | 'INVALID_HEADERS' | 'EXTRA_COLUMNS' | 'TOO_MANY_ROWS' | 'EMPTY_FILE', message: string) {
    super(message);
  }
}

export interface CellIssue { field: string; message: string }
export interface ParsedRow {
  rowNumber: number;
  processName: string;
  serviceProvider: string;
  did: string;
  prefix: string;
  callServer: string;
  cellErrors: CellIssue[];
}
export interface ParsedWorkbook { rows: ParsedRow[]; emptyRows: number }

const FIELD_NAMES = ['processName', 'serviceProvider', 'did', 'prefix', 'callServer'] as const;
const colLetter = (i: number) => String.fromCharCode(64 + i);

export function cellText(v: ExcelJS.CellValue): { text: string; error?: string } {
  if (v === null || v === undefined) return { text: '' };
  if (typeof v === 'string') return { text: v.trim() };
  if (typeof v === 'number') return { text: String(v) };
  if (typeof v === 'boolean' || v instanceof Date) return { text: '', error: 'Only text or numbers are allowed in this column' };
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return { text: '', error: 'Formulas are not allowed; enter the value itself' };
    if ('richText' in v) return { text: v.richText.map((r) => r.text).join('').trim() };
    if ('hyperlink' in v) return { text: String(v.text ?? '').trim() };
    if ('error' in v) return { text: '', error: 'Cell contains an Excel error value' };
  }
  return { text: '', error: 'Unsupported cell content' };
}

/** Reads and strictly validates an uploaded .xlsx. Throws ImportFileError for file-level problems; row problems are returned per row. */
export async function parseCallerWorkbook(buf: Buffer): Promise<ParsedWorkbook> {
  // .xlsx is a ZIP container: check the magic bytes before handing the file to the parser.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new ImportFileError('INVALID_FORMAT', 'The file is not a valid .xlsx workbook. Legacy .xls files are not supported; save the file as .xlsx.');
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    throw new ImportFileError('INVALID_FORMAT', 'The workbook could not be read; it may be corrupted.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new ImportFileError('EMPTY_FILE', 'The workbook has no worksheets.');
  if (ws.rowCount > MAX_SCAN_ROWS) throw new ImportFileError('TOO_MANY_ROWS', `The worksheet is too large (more than ${MAX_SCAN_ROWS} rows).`);

  const head = ws.getRow(1);
  const problems: string[] = [];
  HEADERS.forEach((expected, i) => {
    const raw = head.getCell(i + 1).value;
    const exact = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && 'richText' in raw ? raw.richText.map((r) => r.text).join('') : '';
    if (exact !== expected) problems.push(`column ${colLetter(i + 1)}: expected "${expected}", found "${exact === '' ? '(empty)' : exact}"`);
  });
  if (problems.length) throw new ImportFileError('INVALID_HEADERS', `Invalid headers - ${problems.join('; ')}. The first row must be exactly: ${HEADERS.join(' | ')}.`);
  head.eachCell((cell) => {
    if (Number(cell.col) > HEADERS.length && cellText(cell.value).text !== '') {
      throw new ImportFileError('EXTRA_COLUMNS', `Extra column ${colLetter(Number(cell.col))} found in the header row. The file must contain exactly the five template columns.`);
    }
  });

  const rows: ParsedRow[] = [];
  let emptyRows = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const values = [1, 2, 3, 4, 5].map((c) => cellText(row.getCell(c).value));
    let extra = false;
    row.eachCell((cell) => {
      if (Number(cell.col) > HEADERS.length && cellText(cell.value).text !== '') extra = true;
    });
    if (extra) throw new ImportFileError('EXTRA_COLUMNS', `Row ${r} has data outside the five template columns.`);
    if (values.every((v) => v.text === '' && !v.error)) {
      emptyRows++;
      continue;
    }
    if (rows.length >= MAX_DATA_ROWS) throw new ImportFileError('TOO_MANY_ROWS', `The file has more than ${MAX_DATA_ROWS} records. Split it into smaller files.`);
    const parsed: ParsedRow = { rowNumber: r, processName: '', serviceProvider: '', did: '', prefix: '', callServer: '', cellErrors: [] };
    values.forEach((v, i) => {
      parsed[FIELD_NAMES[i]] = v.text;
      if (v.error) parsed.cellErrors.push({ field: HEADERS[i], message: v.error });
    });
    rows.push(parsed);
  }
  return { rows, emptyRows };
}
