import { z } from 'zod';

/**
 * Validates standard email syntax without allowing display names or whitespace.
 */
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/**
 * Validates international E.164 WhatsApp phone numbers (e.g. +923001234567).
 */
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/**
 * Validates 24-hour HH:mm time strings.
 */
const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const normalized = email.trim();
  if (!normalized || normalized.length > 254) return false;
  return EMAIL_REGEX.test(normalized);
}

export function isValidInternationalPhone(phone: string): boolean {
  const cleaned = phone.trim().replace(/[\s()-]/g, '');
  return E164_REGEX.test(cleaned);
}

export function normalizeInternationalPhone(phone: string): string {
  return phone.trim().replace(/[\s()-]/g, '');
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates destination URLs for click tracking to prevent open redirects / javascript: URLs.
 */
export function isValidHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const emailSchema = z
  .string()
  .trim()
  .min(3, 'Email address is required')
  .max(254, 'Email address is too long')
  .refine(isValidEmail, 'Invalid email address format')
  .transform(normalizeEmail);

export const internationalPhoneSchema = z
  .string()
  .trim()
  .transform(normalizeInternationalPhone)
  .refine(isValidInternationalPhone, 'Phone number must be in international E.164 format (e.g., +923001234567)');

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters long')
  .max(128, 'Password must be at most 128 characters long')
  .refine((val) => /[a-z]/.test(val), 'Password must include a lowercase letter')
  .refine((val) => /[A-Z]/.test(val), 'Password must include an uppercase letter')
  .refine((val) => /\d/.test(val), 'Password must include a number');

export const accountConfigSchema = z
  .object({
    dailySendLimit: z.number().int().min(1, 'Daily limit must be at least 1').max(2000, 'Daily limit cannot exceed 2000'),
    minDelayMinutes: z.number().int().min(1, 'Minimum delay must be greater than 0').max(1440, 'Minimum delay cannot exceed 1440 minutes'),
    maxDelayMinutes: z.number().int().min(1, 'Maximum delay must be greater than 0').max(1440, 'Maximum delay cannot exceed 1440 minutes'),
    scheduleStartTime: z.string().regex(HHMM_REGEX, 'Start time must be in HH:mm format'),
    scheduleEndTime: z.string().regex(HHMM_REGEX, 'End time must be in HH:mm format'),
    timezone: z.string().min(1).refine(isValidTimeZone, 'Invalid IANA time zone'),
    allowedWeekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1, 'Select at least one allowed weekday'),
    signatureHtml: z.string().max(15000).nullable().optional(),
    signatureEnabled: z.boolean().optional(),
    whatsappNotificationsEnabled: z.boolean().optional(),
  })
  .refine((d) => d.maxDelayMinutes >= d.minDelayMinutes, {
    message: 'Maximum delay must be greater than or equal to minimum delay',
    path: ['maxDelayMinutes'],
  })
  .refine((d) => d.scheduleStartTime !== d.scheduleEndTime, {
    message: 'Start time and end time cannot be identical',
    path: ['scheduleEndTime'],
  });

export const campaignCreateSchema = z
  .object({
    name: z.string().trim().min(2, 'Campaign name must be at least 2 characters').max(160),
    outlookAccountId: z.string().min(1, 'Select an Outlook account'),
    leadIds: z.array(z.string().min(1)).optional(),
    startDate: z.string().datetime().nullable().optional(),
    endDate: z.string().datetime().nullable().optional(),
    isTestMode: z.boolean().default(false),
    useAccountDefaults: z.boolean().default(true),
    dailyLimit: z.number().int().min(1).max(2000).optional(),
    minDelayMinutes: z.number().int().min(1).max(1440).optional(),
    maxDelayMinutes: z.number().int().min(1).max(1440).optional(),
    scheduleStartTime: z.string().regex(HHMM_REGEX).optional(),
    scheduleEndTime: z.string().regex(HHMM_REGEX).optional(),
    timezone: z.string().refine(isValidTimeZone, 'Invalid timezone').optional(),
    allowedWeekdays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  })
  .refine(
    (d) => {
      if (d.minDelayMinutes !== undefined && d.maxDelayMinutes !== undefined) {
        return d.maxDelayMinutes >= d.minDelayMinutes;
      }
      return true;
    },
    { message: 'Maximum delay must be >= minimum delay', path: ['maxDelayMinutes'] },
  )
  .refine(
    (d) => {
      if (d.startDate && d.endDate) {
        return new Date(d.endDate) >= new Date(d.startDate);
      }
      return true;
    },
    { message: 'End date must be on or after start date', path: ['endDate'] },
  );

export const LEAD_TEMPLATE_COLUMNS = [
  'email',
  'first_name',
  'last_name',
  'company',
  'subject',
  'body',
  'website',
  'phone',
  'campaign_name',
  'custom_field_1',
  'custom_field_2',
] as const;

export const MANDATORY_LEAD_COLUMNS = ['email', 'subject', 'body'] as const;

export const LEAD_STATUSES = [
  'IMPORTED',
  'VALIDATED',
  'SCHEDULED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'BOUNCED',
  'FAILED',
  'REPLIED',
  'UNSUBSCRIBED',
  'SUPPRESSED',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const EMAIL_STATUSES = [
  'QUEUED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'DELIVERY_UNKNOWN',
  'BOUNCED',
  'FAILED',
  'OPENED',
  'CLICKED',
  'REPLIED',
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];
