import { describe, expect, it } from 'vitest';
import {
  classifyBounceMessage,
  computeNextEligibleSendAt,
  computeRetryBackoffMs,
  extractTemplateVariables,
  formatWhatsAppNotificationMessage,
  generateDelayMinutes,
  getLocalTimeParts,
  isValidEmail,
  isValidHttpUrl,
  isValidInternationalPhone,
  isWithinSendingSchedule,
  plainTextToHtml,
  renderPersonalizedEmail,
} from '../index.js';

describe('validation helpers', () => {
  it('validates email addresses strictly', () => {
    expect(isValidEmail('client@example.com')).toBe(true);
    expect(isValidEmail('john.doe+outreach@sub.domain.co.uk')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('John <client@example.com>')).toBe(false);
    expect(isValidEmail('bad@localhost')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });

  it('validates international E.164 phone numbers', () => {
    expect(isValidInternationalPhone('+923001234567')).toBe(true);
    expect(isValidInternationalPhone('+1 415 555 2671')).toBe(true);
    expect(isValidInternationalPhone('03001234567')).toBe(false);
    expect(isValidInternationalPhone('+0123456')).toBe(false);
    expect(isValidInternationalPhone('abc')).toBe(false);
  });

  it('validates click tracking URLs and blocks open redirect / XSS protocols', () => {
    expect(isValidHttpUrl('https://example.com/pricing?utm=1')).toBe(true);
    expect(isValidHttpUrl('http://sub.example.org')).toBe(true);
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isValidHttpUrl('data:text/html,<script>')).toBe(false);
    expect(isValidHttpUrl('//evil.com')).toBe(false);
  });
});

describe('personalization engine', () => {
  it('substitutes standard and custom variables and tracks missing variables', () => {
    const vars = extractTemplateVariables('Hello {{first_name}} at {{company}} ({{custom_field_1}})');
    expect(vars).toEqual(['first_name', 'company', 'custom_field_1']);

    const ok = renderPersonalizedEmail(
      'Proposal for {{company}}',
      'Hi {{first_name}},\n\nSaw {{website}} and {{custom_field_1}}.',
      {
        email: 'john@acme.com',
        first_name: 'John',
        company: 'Acme Inc',
        website: 'https://acme.com',
        custom_field_1: 'Series A growth',
      },
    );
    expect(ok.isValid).toBe(true);
    expect(ok.missingVariables).toEqual([]);
    expect(ok.renderedSubject).toBe('Proposal for Acme Inc');
    expect(ok.renderedBody).toContain('Hi John,');
    expect(ok.renderedBody).toContain('Series A growth');

    const missing = renderPersonalizedEmail(
      'Proposal for {{company}}',
      'Hi {{first_name}}',
      { email: 'john@acme.com', company: 'Acme Inc', first_name: '' },
    );
    expect(missing.isValid).toBe(false);
    expect(missing.missingVariables).toEqual(['first_name']);
  });

  it('escapes HTML injection in plain text while preserving line breaks and URLs', () => {
    const html = plainTextToHtml('Hello <script>alert(1)</script>\n\nVisit https://example.com/demo\nThanks');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<a href="https://example.com/demo"');
    expect(html).toContain('<br />');
  });
});

describe('schedule, timezone, DST, and delay calculations', () => {
  it('handles DST transitions accurately in America/New_York', () => {
    // 2026-03-08 15:00 UTC is 11:00 AM EDT (DST starts 2026-03-08 02:00 AM)
    const dstStartDay = new Date('2026-03-08T15:00:00Z');
    const partsEdt = getLocalTimeParts(dstStartDay, 'America/New_York');
    expect(partsEdt.dateKey).toBe('2026-03-08');
    expect(partsEdt.weekday).toBe(0); // Sunday
    expect(partsEdt.minutesSinceMidnight).toBe(11 * 60);

    // 2026-01-15 15:00 UTC is 10:00 AM EST
    const winterDay = new Date('2026-01-15T15:00:00Z');
    const partsEst = getLocalTimeParts(winterDay, 'America/New_York');
    expect(partsEst.dateKey).toBe('2026-01-15');
    expect(partsEst.weekday).toBe(4); // Thursday
    expect(partsEst.minutesSinceMidnight).toBe(10 * 60);

    const allowed = isWithinSendingSchedule(winterDay, {
      scheduleStartTime: '09:00',
      scheduleEndTime: '17:00',
      timezone: 'America/New_York',
      allowedWeekdays: [1, 2, 3, 4, 5],
    });
    expect(allowed.allowed).toBe(true);

    const outside = isWithinSendingSchedule(new Date('2026-01-15T23:00:00Z'), {
      scheduleStartTime: '09:00',
      scheduleEndTime: '17:00',
      timezone: 'America/New_York',
      allowedWeekdays: [1, 2, 3, 4, 5],
    });
    expect(outside.allowed).toBe(false);
  });

  it('generates delays within [min, max] inclusive and respects Retry-After backoff', () => {
    expect(generateDelayMinutes(15, 20, () => 0)).toBe(15);
    expect(generateDelayMinutes(15, 20, () => 0.999)).toBe(20);
    const next = computeNextEligibleSendAt(new Date('2026-01-01T10:00:00Z'), 25, 30, () => 0);
    expect(next.delayMinutes).toBe(25);
    expect(next.nextEligibleAt.toISOString()).toBe('2026-01-01T10:25:00.000Z');

    const retryAfterMs = computeRetryBackoffMs(1, 120, () => 0.5);
    expect(retryAfterMs).toBeGreaterThanOrEqual(120_000);
    expect(retryAfterMs).toBeLessThan(123_000);
  });
});

describe('bounce classifier and WhatsApp formatting', () => {
  it('classifies hard, soft, delivered DSN, and unknown bounces', () => {
    const hard = classifyBounceMessage({
      senderEmail: 'postmaster@outlook.com',
      subject: 'Undeliverable: Website proposal',
      bodyText: 'Final-Recipient: rfc822; missing@example.com\nAction: failed\nStatus: 5.1.1\n550 5.1.1 User unknown',
    });
    expect(hard.isBounceOrDsn).toBe(true);
    expect(hard.classification).toBe('HARD');
    expect(hard.smtpCode).toBe('5.1.1');
    expect(hard.failedRecipient).toBe('missing@example.com');

    const soft = classifyBounceMessage({
      senderEmail: 'Mailer-Daemon@mail.example.com',
      subject: 'Delivery Status Notification (Delay)',
      bodyText: 'Final-Recipient: rfc822; full@example.com\nStatus: 4.2.2\nMailbox full, try again later',
    });
    expect(soft.classification).toBe('SOFT');

    const delivered = classifyBounceMessage({
      senderEmail: 'postmaster@example.com',
      subject: 'Delivery Status Notification',
      bodyText: 'Final-Recipient: rfc822; ok@example.com\nAction: delivered',
    });
    expect(delivered.classification).toBe('DELIVERED_DSN');

    const normal = classifyBounceMessage({
      senderEmail: 'john@client.com',
      subject: 'Re: Website proposal',
      bodyText: 'Sounds good, let us meet Thursday.',
    });
    expect(normal.isBounceOrDsn).toBe(false);
  });

  it('formats WhatsApp notifications without exposing body unless enabled', () => {
    const msg = formatWhatsAppNotificationMessage({
      eventType: 'OUTREACH_REPLY',
      outlookEmail: 'sender@outlook.com',
      senderName: 'John Smith',
      senderEmail: 'john@client.com',
      subject: 'Website proposal',
      campaignName: 'Q1 SaaS',
      receivedAt: new Date('2026-01-15T14:45:00Z'),
      timezone: 'UTC',
      bodyPreview: 'Secret body text',
      includeBodyPreview: false,
    });
    expect(msg).toContain('Outlook: sender@outlook.com');
    expect(msg).toContain('Type: Campaign reply');
    expect(msg).not.toContain('Secret body text');

    const withPreview = formatWhatsAppNotificationMessage({
      eventType: 'NEW_EMAIL',
      outlookEmail: 'sender@outlook.com',
      senderEmail: 'john@client.com',
      subject: 'Hello',
      bodyPreview: 'Short preview here',
      includeBodyPreview: true,
    });
    expect(withPreview).toContain('Preview: Short preview here');
  });
});
