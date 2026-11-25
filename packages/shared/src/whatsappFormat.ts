export interface WhatsAppAlertPayload {
  eventType: 'NEW_EMAIL' | 'OUTREACH_REPLY' | 'CAMPAIGN_COMPLETE' | 'SEND_ERROR' | 'WHATSAPP_ERROR' | 'TEST';
  outlookEmail?: string;
  senderName?: string | null;
  senderEmail?: string;
  subject?: string;
  campaignName?: string | null;
  receivedAt?: Date;
  timezone?: string;
  bodyPreview?: string | null;
  includeBodyPreview?: boolean;
  errorMessage?: string;
}

export function formatAlertTime(date: Date, timezone = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Formats personal WhatsApp notification alerts without leaking full email bodies unless explicitly opted in.
 */
export function formatWhatsAppNotificationMessage(payload: WhatsAppAlertPayload): string {
  const timeLabel = formatAlertTime(payload.receivedAt ?? new Date(), payload.timezone ?? 'UTC');

  if (payload.eventType === 'TEST') {
    return [
      'Outreach Engine test notification',
      `Status: Connected and ready`,
      `Time: ${timeLabel}`,
    ].join('\n');
  }

  if (payload.eventType === 'CAMPAIGN_COMPLETE') {
    return [
      'Campaign completed!',
      `Outlook: ${payload.outlookEmail ?? 'Unknown'}`,
      `Campaign: ${payload.campaignName ?? 'Outreach Campaign'}`,
      `Time: ${timeLabel}`,
    ].join('\n');
  }

  if (payload.eventType === 'SEND_ERROR') {
    return [
      'Email sending error detected',
      `Outlook: ${payload.outlookEmail ?? 'Unknown'}`,
      payload.campaignName ? `Campaign: ${payload.campaignName}` : null,
      `Error: ${(payload.errorMessage ?? 'Unknown error').slice(0, 220)}`,
      `Time: ${timeLabel}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (payload.eventType === 'WHATSAPP_ERROR') {
    return [
      'WhatsApp connection warning',
      `Details: ${(payload.errorMessage ?? 'Session interrupted').slice(0, 220)}`,
      `Time: ${timeLabel}`,
    ].join('\n');
  }

  const isReply = payload.eventType === 'OUTREACH_REPLY';
  const fromDisplay = payload.senderName
    ? `${payload.senderName} <${payload.senderEmail ?? ''}>`
    : payload.senderEmail ?? 'Unknown sender';

  const lines = [
    isReply ? 'New campaign reply received!' : 'New email received!',
    `Outlook: ${payload.outlookEmail ?? 'Unknown'}`,
    `From: ${fromDisplay}`,
    `Subject: ${payload.subject || '(No subject)'}`,
    `Type: ${isReply ? 'Campaign reply' : 'Direct / Inbox email'}`,
    isReply && payload.campaignName ? `Campaign: ${payload.campaignName}` : null,
    `Time: ${timeLabel}`,
  ].filter((line): line is string => Boolean(line));

  if (payload.includeBodyPreview && payload.bodyPreview) {
    const snippet = payload.bodyPreview.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (snippet) {
      lines.push(`Preview: ${snippet}${payload.bodyPreview.trim().length > 160 ? '...' : ''}`);
    }
  }

  return lines.join('\n');
}
