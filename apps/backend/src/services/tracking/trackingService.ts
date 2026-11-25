import {
  appendSignatureHtml,
  isValidHttpUrl,
  looksLikeHtml,
  plainTextToHtml,
} from '@outreach-engine/shared';
import {
  generateRandomToken,
  signTrackingPayload,
} from '../../crypto/security.js';
import { sanitizeEmailHtml } from '../../utils/sanitizer.js';

export const TRANSPARENT_GIF_BUFFER = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

export interface TrackingLinkCreateInput {
  token: string;
  emailMessageId: string;
  leadId: string | null;
  campaignId: string | null;
  destinationUrl: string;
}

export interface TrackingDb {
  trackingLink: {
    create(args: { data: TrackingLinkCreateInput }): Promise<unknown>;
  };
}

/**
 * Renders sanitized email HTML + signature for UI preview WITHOUT inserting tracking pixels or link redirects.
 */
export function buildEmailPreviewHtml(params: {
  rawBody: string;
  isHtmlBody: boolean;
  signatureHtml?: string | null;
  signatureEnabled?: boolean;
}): string {
  const baseHtml = params.isHtmlBody
    ? sanitizeEmailHtml(params.rawBody)
    : plainTextToHtml(params.rawBody);
  const sanitizedSignature = params.signatureHtml ? sanitizeEmailHtml(params.signatureHtml) : null;
  return appendSignatureHtml(baseHtml, sanitizedSignature, Boolean(params.signatureEnabled));
}

/**
 * Prepares the outbound email HTML by sanitizing content, appending optional signature,
 * rewriting valid http/https links through HMAC-signed click trackers, adding an unsubscribe footer,
 * and inserting an optional 1x1 tracking pixel.
 */
export async function prepareTrackedOutboundHtml(params: {
  db: TrackingDb;
  emailMessageId: string;
  leadId: string | null;
  campaignId: string | null;
  rawBody: string;
  isHtmlBody?: boolean;
  signatureHtml?: string | null;
  signatureEnabled?: boolean;
  openTrackingEnabled: boolean;
  clickTrackingEnabled: boolean;
  unsubscribeFooterEnabled: boolean;
  baseUrl: string;
  trackingSecret: string;
}): Promise<{ html: string; unsubscribeUrl?: string }> {
  const isHtml = params.isHtmlBody ?? looksLikeHtml(params.rawBody);
  let html = buildEmailPreviewHtml({
    rawBody: params.rawBody,
    isHtmlBody: isHtml,
    signatureHtml: params.signatureHtml,
    signatureEnabled: params.signatureEnabled,
  });

  if (params.clickTrackingEnabled) {
    const anchorRegex = /<a\b([^>]*?)\bhref=(["'])(https?:\/\/[^"']+)\2([^>]*)>/gi;
    const replacements: Array<{ original: string; replacement: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = anchorRegex.exec(html)) !== null) {
      const fullTag = match[0];
      const beforeHref = match[1] ?? '';
      const quote = match[2] ?? '"';
      const destinationUrl = match[3] ?? '';
      const afterHref = match[4] ?? '';

      if (!isValidHttpUrl(destinationUrl)) continue;
      if (destinationUrl.startsWith(`${params.baseUrl}/t/`)) continue;

      const rawToken = generateRandomToken(18);
      await params.db.trackingLink.create({
        data: {
          token: rawToken,
          emailMessageId: params.emailMessageId,
          leadId: params.leadId,
          campaignId: params.campaignId,
          destinationUrl,
        },
      });

      const signedToken = signTrackingPayload(rawToken, 'click', params.trackingSecret);
      const trackedUrl = `${params.baseUrl}/t/c/${encodeURIComponent(signedToken)}`;
      const replacedTag = `<a${beforeHref}href=${quote}${trackedUrl}${quote}${afterHref}>`;
      replacements.push({ original: fullTag, replacement: replacedTag });
    }

    for (const item of replacements) {
      html = html.replace(item.original, item.replacement);
    }
  }

  let unsubscribeUrl: string | undefined;
  if (params.unsubscribeFooterEnabled && params.leadId) {
    const unsubToken = signTrackingPayload(params.emailMessageId, 'unsub', params.trackingSecret);
    unsubscribeUrl = `${params.baseUrl}/t/u/${encodeURIComponent(unsubToken)}`;
    html += `\n<div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">If you prefer not to receive future emails from this sender, you may <a href="${unsubscribeUrl}" style="color: #475569; text-decoration: underline;">unsubscribe here</a>.</div>`;
  }

  if (params.openTrackingEnabled) {
    const openToken = signTrackingPayload(params.emailMessageId, 'open', params.trackingSecret);
    const pixelUrl = `${params.baseUrl}/t/o/${encodeURIComponent(openToken)}.gif`;
    html += `\n<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
  }

  return { html, unsubscribeUrl };
}
