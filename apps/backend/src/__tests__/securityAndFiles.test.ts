import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  signTrackingPayload,
  verifyPassword,
  verifyTrackingToken,
} from '../crypto/security.js';
import {
  generateInvalidRowsCsv,
  generateLeadTemplateCsv,
  generateLeadTemplateXlsx,
  previewLeadImport,
} from '../services/leads/leadFileService.js';
import { sanitizeEmailHtml } from '../utils/sanitizer.js';

describe('crypto and security utilities', () => {
  const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('encrypts and decrypts OAuth tokens using AES-256-GCM with unique IVs and tamper detection', () => {
    const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.mock-secret-refresh-token';
    const c1 = encryptSecret(token, key);
    const c2 = encryptSecret(token, key);

    expect(c1).not.toBe(c2);
    expect(c1).not.toContain(token);
    expect(decryptSecret(c1, key)).toBe(token);
    expect(decryptSecret(c2, key)).toBe(token);

    const tampered = c1.slice(0, -4) + 'AAAA';
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('hashes and verifies passwords with scrypt and random salt', () => {
    const hash = hashPassword('StrongOutreachPass123!');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('StrongOutreachPass123!', hash)).toBe(true);
    expect(verifyPassword('WrongPassword123!', hash)).toBe(false);
  });

  it('signs and verifies HMAC tracking tokens', () => {
    const secret = 'tracking-secret-32-chars-minimum-value';
    const signed = signTrackingPayload('msg_123', 'click', secret);
    expect(verifyTrackingToken(signed, 'click', secret)).toBe('msg_123');
    expect(verifyTrackingToken(signed, 'open', secret)).toBeNull();
    expect(verifyTrackingToken(`${signed}x`, 'click', secret)).toBeNull();
  });

  it('sanitizes HTML bodies to prevent script injection while keeping links', () => {
    const dirty =
      '<p>Hello</p><script>alert("xss")</script><a href="https://example.com" onclick="steal()">Link</a><a href="javascript:alert(1)">Bad</a>';
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('https://example.com');
    expect(clean).toContain('<p>Hello</p>');
  });
});

describe('lead template generation, CSV/XLSX parsing, and validation', () => {
  it('generates downloadable CSV and XLSX lead templates with mandatory columns and example row', async () => {
    const csvBuf = generateLeadTemplateCsv();
    const csvText = csvBuf.toString('utf8');
    expect(csvText).toContain('email,first_name,last_name,company,subject,body,website,phone,campaign_name,custom_field_1,custom_field_2');
    expect(csvText).toContain('john.smith@example.com');

    const xlsxBuf = await generateLeadTemplateXlsx();
    const preview = await previewLeadImport({
      buffer: xlsxBuf,
      filename: 'template.xlsx',
      existingAccountEmails: new Map(),
    });
    expect(preview.fileType).toBe('XLSX');
    expect(preview.validRows).toHaveLength(1);
    expect(preview.validRows[0]?.email).toBe('john.smith@example.com');
  });

  it('validates rows, catches missing personalization variables, detects duplicates, and generates invalid CSV report', async () => {
    const csv = [
      'email,first_name,company,subject,body,custom_field_1',
      'valid1@acme.com,Alice,Acme,Hello {{company}},Hi {{first_name}} saw {{custom_field_1}},launch',
      'valid1@acme.com,Alice,Acme,Duplicate in file,Body here,launch',
      'existing@acme.com,Bob,Acme,Existing account dup,Body here,launch',
      'bad-email,Carol,Acme,Subject,Body,launch',
      'missingvar@acme.com,,Acme,Subject,Hi {{first_name}}!,launch',
      'nosubject@acme.com,Dan,Acme,,Body here,launch',
    ].join('\n');

    const existing = new Map([['existing@acme.com', 'lead_existing_1']]);
    const result = await previewLeadImport({
      buffer: Buffer.from(csv, 'utf8'),
      filename: 'leads.csv',
      existingAccountEmails: existing,
    });

    expect(result.totalRows).toBe(6);
    expect(result.validRows).toHaveLength(1);
    expect(result.validRows[0]?.email).toBe('valid1@acme.com');
    expect(result.duplicateRows).toHaveLength(2);
    expect(result.duplicateRows[0]?.reason).toBe('DUPLICATE_IN_FILE');
    expect(result.duplicateRows[1]?.reason).toBe('ALREADY_EXISTS_IN_ACCOUNT');
    expect(result.invalidRows).toHaveLength(3);

    const invalidReport = generateInvalidRowsCsv(result.invalidRows).toString('utf8');
    expect(invalidReport).toContain('Invalid email address');
    expect(invalidReport).toContain('Missing personalization variable(s): first_name');
    expect(invalidReport).toContain('Missing mandatory email subject');
  });
});
