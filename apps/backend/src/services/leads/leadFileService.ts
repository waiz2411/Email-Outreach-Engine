import { parse as parseCsv } from 'csv-parse/sync';
import { stringify as stringifyCsv } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import {
  LEAD_TEMPLATE_COLUMNS,
  extractTemplateVariables,
  isValidEmail,
  looksLikeHtml,
  normalizeEmail,
  renderPersonalizedEmail,
} from '@outreach-engine/shared';
import { sanitizeEmailHtml } from '../../utils/sanitizer.js';

export interface ParsedLeadRow {
  rowNumber: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  subject: string;
  body: string;
  isHtmlBody: boolean;
  website: string | null;
  phone: string | null;
  campaignNameHint: string | null;
  customFields: Record<string, string>;
}

export interface InvalidLeadRow {
  rowNumber: number;
  email: string;
  subject: string;
  errors: string[];
  raw: Record<string, string>;
}

export interface DuplicateLeadRow {
  rowNumber: number;
  email: string;
  reason: 'DUPLICATE_IN_FILE' | 'ALREADY_EXISTS_IN_ACCOUNT';
  existingLeadId?: string;
  parsed: ParsedLeadRow;
}

export interface LeadImportPreviewResult {
  fileType: 'CSV' | 'XLSX';
  totalRows: number;
  validRows: ParsedLeadRow[];
  invalidRows: InvalidLeadRow[];
  duplicateRows: DuplicateLeadRow[];
  detectedColumns: string[];
  missingMandatoryColumns: string[];
}

const TEMPLATE_EXAMPLE_ROW: Record<(typeof LEAD_TEMPLATE_COLUMNS)[number], string> = {
  email: 'john.smith@example.com',
  first_name: 'John',
  last_name: 'Smith',
  company: 'Acme Studio',
  subject: 'Website proposal for {{company}}',
  body: 'Hello {{first_name}},\n\nI noticed that {{company}} recently launched {{custom_field_1}} and wanted to share a quick idea.\n\nBest regards,',
  website: 'https://example.com',
  phone: '+14155550199',
  campaign_name: 'Q1 SaaS Outreach',
  custom_field_1: 'your new product page',
  custom_field_2: 'San Francisco',
};

export function generateLeadTemplateCsv(): Buffer {
  const csv = stringifyCsv([TEMPLATE_EXAMPLE_ROW], {
    header: true,
    columns: [...LEAD_TEMPLATE_COLUMNS],
  });
  return Buffer.from(csv, 'utf8');
}

export async function generateLeadTemplateXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Leads Template');
  sheet.columns = LEAD_TEMPLATE_COLUMNS.map((col) => ({
    header: col,
    key: col,
    width: col === 'body' ? 45 : col === 'subject' ? 30 : 20,
  }));
  sheet.addRow(TEMPLATE_EXAMPLE_ROW);
  sheet.getRow(1).font = { bold: true };
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function normalizeHeaderName(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, '_');
}

function cellToString(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.result === 'string' || typeof obj.result === 'number') return String(obj.result);
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((part) => String((part as { text?: string }).text ?? '')).join('');
    }
  }
  return String(val);
}

export async function parseLeadFileBuffer(
  buffer: Buffer,
  filename: string,
): Promise<{ fileType: 'CSV' | 'XLSX'; rows: Array<Record<string, string>>; headers: string[] }> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx')) {
    const workbook = new ExcelJS.Workbook();
    // ExcelJS typings expect Buffer/ArrayBuffer; cast safely for Node 24 Buffer<ArrayBufferLike>
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      return { fileType: 'XLSX', rows: [], headers: [] };
    }
    const headers: string[] = [];
    const headerRow = sheet.getRow(1);
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      headers[colNumber - 1] = normalizeHeaderName(cellToString(cell.value));
    });

    const rows: Array<Record<string, string>> = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const record: Record<string, string> = {};
      let hasAnyValue = false;
      for (let c = 0; c < headers.length; c++) {
        const key = headers[c];
        if (!key) continue;
        const val = cellToString(row.getCell(c + 1).value).trim();
        if (val) hasAnyValue = true;
        record[key] = val;
      }
      if (hasAnyValue) {
        rows.push(record);
      }
    }
    return {
      fileType: 'XLSX',
      rows,
      headers: headers.filter(Boolean),
    };
  }

  // Default CSV parsing (strips UTF-8 BOM if present)
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(text, {
    columns: (headerRow: string[]) => headerRow.map(normalizeHeaderName),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Array<Record<string, string>>;

  const headers = records[0] ? Object.keys(records[0]) : [];
  return { fileType: 'CSV', rows: records, headers };
}

/**
 * Parses and validates every row in a CSV/XLSX upload against mandatory columns, email format,
 * personalization variables, and duplicates within the file + existing leads for the target account.
 */
export async function previewLeadImport(params: {
  buffer: Buffer;
  filename: string;
  existingAccountEmails: Map<string, string>; // normalizedEmail -> leadId
}): Promise<LeadImportPreviewResult> {
  const { fileType, rows, headers } = await parseLeadFileBuffer(params.buffer, params.filename);

  const missingMandatoryColumns = (['email', 'subject', 'body'] as const).filter(
    (col) => !headers.includes(col),
  );

  const validRows: ParsedLeadRow[] = [];
  const invalidRows: InvalidLeadRow[] = [];
  const duplicateRows: DuplicateLeadRow[] = [];
  const seenInFile = new Set<string>();

  rows.forEach((raw, idx) => {
    const rowNumber = idx + 2; // 1-indexed with header row at 1
    const rawEmail = (raw.email ?? '').trim();
    const email = normalizeEmail(rawEmail);
    const subject = (raw.subject ?? '').trim();
    const rawBody = raw.body ?? '';
    const isHtmlBody = looksLikeHtml(rawBody);
    const body = isHtmlBody ? sanitizeEmailHtml(rawBody).trim() : rawBody.trim();

    const errors: string[] = [];
    if (!email) {
      errors.push('Missing mandatory email address');
    } else if (!isValidEmail(email)) {
      errors.push(`Invalid email address: "${rawEmail}"`);
    }

    if (!subject) {
      errors.push('Missing mandatory email subject');
    }
    if (!body) {
      errors.push('Missing mandatory email body');
    }

    const customFields: Record<string, string> = {};
    const standardKeys = new Set([
      'email',
      'first_name',
      'last_name',
      'company',
      'subject',
      'body',
      'website',
      'phone',
      'campaign_name',
    ]);
    for (const [k, v] of Object.entries(raw)) {
      if (!standardKeys.has(k) && v !== undefined && v !== '') {
        customFields[k] = String(v).trim();
      }
    }

    const parsed: ParsedLeadRow = {
      rowNumber,
      email,
      firstName: raw.first_name?.trim() || null,
      lastName: raw.last_name?.trim() || null,
      company: raw.company?.trim() || null,
      subject,
      body,
      isHtmlBody,
      website: raw.website?.trim() || null,
      phone: raw.phone?.trim() || null,
      campaignNameHint: raw.campaign_name?.trim() || null,
      customFields,
    };

    // Validate personalization variables can be satisfied by this row
    if (subject && body) {
      const vars = new Set([
        ...extractTemplateVariables(subject),
        ...extractTemplateVariables(body),
      ]);
      if (vars.size > 0) {
        const rendered = renderPersonalizedEmail(subject, body, {
          email,
          first_name: parsed.firstName,
          last_name: parsed.lastName,
          company: parsed.company,
          website: parsed.website,
          phone: parsed.phone,
          ...customFields,
        });
        if (rendered.missingVariables.length > 0) {
          errors.push(`Missing personalization variable(s): ${rendered.missingVariables.join(', ')}`);
        }
      }
    }

    if (errors.length > 0) {
      invalidRows.push({
        rowNumber,
        email: rawEmail,
        subject,
        errors,
        raw,
      });
      return;
    }

    if (seenInFile.has(email)) {
      duplicateRows.push({
        rowNumber,
        email,
        reason: 'DUPLICATE_IN_FILE',
        parsed,
      });
      return;
    }
    seenInFile.add(email);

    const existingLeadId = params.existingAccountEmails.get(email);
    if (existingLeadId) {
      duplicateRows.push({
        rowNumber,
        email,
        reason: 'ALREADY_EXISTS_IN_ACCOUNT',
        existingLeadId,
        parsed,
      });
      return;
    }

    validRows.push(parsed);
  });

  return {
    fileType,
    totalRows: rows.length,
    validRows,
    invalidRows,
    duplicateRows,
    detectedColumns: headers,
    missingMandatoryColumns,
  };
}

export function generateInvalidRowsCsv(invalidRows: InvalidLeadRow[]): Buffer {
  const formatted = invalidRows.map((row) => ({
    row_number: row.rowNumber,
    email: row.email,
    subject: row.subject,
    errors: row.errors.join('; '),
    first_name: row.raw.first_name ?? '',
    last_name: row.raw.last_name ?? '',
    company: row.raw.company ?? '',
  }));
  return Buffer.from(stringifyCsv(formatted, { header: true }), 'utf8');
}

export function generateGenericCsvExport(rows: Array<Record<string, unknown>>): Buffer {
  if (rows.length === 0) {
    return Buffer.from('', 'utf8');
  }
  return Buffer.from(stringifyCsv(rows, { header: true }), 'utf8');
}
