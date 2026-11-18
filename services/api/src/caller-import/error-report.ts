/**
 * CSV error report. Every cell is quoted and neutralised against spreadsheet formula injection (CSV injection):
 * values beginning with = + - @ tab or CR are prefixed with a single quote so Excel treats them as text.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export interface ReportRow {
  rowNumber: number;
  processName: string | null;
  serviceProvider: string | null;
  did: string | null;
  prefix: string | null;
  callServer: string | null;
  status: string;
  errors: { code: string; message: string }[];
}

export const REPORT_HEADERS = ['Row', 'Process Name', 'Service Provider', 'DID', 'Prefix', 'Call Server', 'Status', 'Error Codes', 'Error Messages'];

export function buildErrorReportCsv(rows: ReportRow[]): string {
  const lines = [REPORT_HEADERS.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.rowNumber, r.processName, r.serviceProvider, r.did, r.prefix, r.callServer, r.status,
      r.errors.map((e) => e.code).join('; '), r.errors.map((e) => e.message).join(' '),
    ].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
