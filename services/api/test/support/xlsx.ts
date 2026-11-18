import ExcelJS from 'exceljs';
import { HEADERS } from '../../src/caller-import/excel-format';

/** Builds an .xlsx in memory. Cells are written as given (strings or numbers); pass raw objects for formulas etc. */
export async function makeWorkbook(rows: (string | number | null | ExcelJS.CellValue)[][], headers: readonly string[] = HEADERS, sheetName = 'Callers'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow([...headers]);
  for (const r of rows) ws.addRow(r as ExcelJS.CellValue[]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const SAMPLE_ROWS: string[][] = [
  ['Tata', 'Tata', '2233445511', '91', 'Asterisk-01'],
  ['Airtel', 'Airtel', '2233445522', '91', 'Asterisk-01'],
  ['Jio', 'Jio', '2233445533', '91', 'Asterisk-02'],
  ['Vodafone', 'Vodafone Idea', '2233445544', '91', 'Asterisk-02'],
];

/** Appends a unique suffix so parallel/repeated test runs never collide on master-data names or DIDs. */
export function uniqueRows(run: string, rows: string[][] = SAMPLE_ROWS, didBase = 0): string[][] {
  return rows.map((r, i) => [`${r[0]}-${run}`, `${r[1]}-${run}`, String(Number(r[2]) + didBase + Math.floor(Math.random() * 1e6) * 100 + i), r[3], `${r[4]}-${run}`]);
}
