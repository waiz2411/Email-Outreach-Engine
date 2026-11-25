export type BounceClassification = 'HARD' | 'SOFT' | 'UNKNOWN' | 'DELIVERED_DSN' | 'NONE';

export interface BounceParseInput {
  senderEmail: string;
  subject: string;
  bodyText: string;
  headers?: Array<{ name: string; value: string }>;
}

export interface BounceParseResult {
  isBounceOrDsn: boolean;
  classification: BounceClassification;
  smtpCode?: string;
  failedRecipient?: string;
  reason?: string;
}

const NDR_SENDER_PATTERNS = [
  'mailer-daemon',
  'postmaster',
  'microsoftexchange',
  'maildelivery',
  'noreply@',
  'bounce',
];

const NDR_SUBJECT_PATTERNS = [
  'undeliverable',
  'delivery status notification',
  'delivery failure',
  'delivery has failed',
  'returned mail',
  'mail delivery failed',
  'failure notice',
  'delayed mail',
  'message could not be delivered',
];

/**
 * Classifies incoming system DSN/NDR emails into Hard Bounce, Soft Bounce, Delivered DSN, or Unknown.
 */
export function classifyBounceMessage(input: BounceParseInput): BounceParseResult {
  const senderLower = input.senderEmail.trim().toLowerCase();
  const subjectLower = input.subject.trim().toLowerCase();
  const body = input.bodyText || '';
  const bodyLower = body.toLowerCase();
  const contentTypeHeader = input.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';

  const looksLikeSystemSender = NDR_SENDER_PATTERNS.some((p) => senderLower.includes(p));
  const looksLikeNdrSubject = NDR_SUBJECT_PATTERNS.some((p) => subjectLower.includes(p));
  const isMultipartReport = contentTypeHeader.includes('multipart/report') || contentTypeHeader.includes('delivery-status');

  if (!looksLikeSystemSender && !looksLikeNdrSubject && !isMultipartReport) {
    return { isBounceOrDsn: false, classification: 'NONE' };
  }

  // Extract recipient from RFC 3464 fields or common Microsoft Exchange NDR text
  const recipientMatch =
    body.match(/(?:Final-Recipient|Original-Recipient)\s*:\s*(?:rfc822;)?\s*([^\s<>;"'\r\n]+@[^\s<>;"'\r\n]+)/i) ??
    body.match(/(?:Delivery has failed to these recipients or groups|wasn't delivered to|failed for the following recipient)[\s:]*([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+)/i);
  const failedRecipient = recipientMatch?.[1]?.trim().toLowerCase();

  // Check explicit RFC 3464 Action: delivered
  if (/action\s*:\s*delivered/i.test(body) && !/action\s*:\s*failed/i.test(body)) {
    return {
      isBounceOrDsn: true,
      classification: 'DELIVERED_DSN',
      failedRecipient,
      reason: 'Provider Delivery Status Notification confirmed delivery',
    };
  }

  // Look for Enhanced SMTP Status Codes (e.g. 5.1.1 or 4.2.2) or 3-digit SMTP codes
  const enhancedMatch = body.match(/\b([45]\.\d{1,3}\.\d{1,3})\b/);
  const basicSmtpMatch = body.match(/\b([45]\d{2})\s+[45]\.\d{1,3}\.\d{1,3}\b/) ?? body.match(/\b([45](?:5\d|2\d|1\d))\b/);
  const smtpCode = enhancedMatch?.[1] ?? basicSmtpMatch?.[1];

  if (smtpCode) {
    if (smtpCode.startsWith('5')) {
      return {
        isBounceOrDsn: true,
        classification: 'HARD',
        smtpCode,
        failedRecipient,
        reason: `Permanent delivery failure (${smtpCode})`,
      };
    }
    if (smtpCode.startsWith('4')) {
      return {
        isBounceOrDsn: true,
        classification: 'SOFT',
        smtpCode,
        failedRecipient,
        reason: `Temporary delivery deferral (${smtpCode})`,
      };
    }
  }

  // Keyword heuristics when SMTP codes are stripped
  if (
    bodyLower.includes('does not exist') ||
    bodyLower.includes('user unknown') ||
    bodyLower.includes('no such user') ||
    bodyLower.includes('recipient address rejected') ||
    bodyLower.includes('bad destination mailbox') ||
    bodyLower.includes('invalid recipient')
  ) {
    return {
      isBounceOrDsn: true,
      classification: 'HARD',
      failedRecipient,
      reason: 'Permanent recipient rejection reported by mail server',
    };
  }

  if (
    bodyLower.includes('mailbox full') ||
    bodyLower.includes('over quota') ||
    bodyLower.includes('temporarily deferred') ||
    bodyLower.includes('try again later') ||
    bodyLower.includes('delivery delayed')
  ) {
    return {
      isBounceOrDsn: true,
      classification: 'SOFT',
      failedRecipient,
      reason: 'Temporary mailbox deferral or quota limit',
    };
  }

  if (looksLikeNdrSubject || isMultipartReport) {
    return {
      isBounceOrDsn: true,
      classification: 'UNKNOWN',
      failedRecipient,
      reason: 'Bounce notification detected without explicit SMTP failure classification',
    };
  }

  return { isBounceOrDsn: false, classification: 'NONE' };
}
