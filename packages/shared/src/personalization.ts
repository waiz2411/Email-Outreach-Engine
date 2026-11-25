export interface PersonalizationContext {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  website?: string | null;
  phone?: string | null;
  custom_field_1?: string | null;
  custom_field_2?: string | null;
  [key: string]: string | null | undefined;
}

export interface PersonalizationResult {
  renderedSubject: string;
  renderedBody: string;
  missingVariables: string[];
  isValid: boolean;
}

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Extracts unique personalization variable names like `first_name` from text.
 */
export function extractTemplateVariables(text: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  while ((match = regex.exec(text)) !== null) {
    if (match[1]) {
      found.add(match[1]);
    }
  }
  return Array.from(found);
}

/**
 * Renders subject and body using lead-specific values and records any missing placeholders.
 */
export function renderPersonalizedEmail(
  subjectTemplate: string,
  bodyTemplate: string,
  context: PersonalizationContext,
): PersonalizationResult {
  const missingSet = new Set<string>();

  const lookup = (key: string): string | undefined => {
    const aliases: Record<string, string> = {
      firstName: 'first_name',
      lastName: 'last_name',
      customField1: 'custom_field_1',
      customField2: 'custom_field_2',
    };
    const canonical = aliases[key] ?? key;
    const raw = context[key] ?? context[canonical];
    if (raw === undefined || raw === null) return undefined;
    const trimmed = String(raw).trim();
    return trimmed.length > 0 ? String(raw) : undefined;
  };

  const replaceAll = (input: string): string =>
    input.replace(PLACEHOLDER_REGEX, (full, varName: string) => {
      const value = lookup(varName);
      if (value === undefined) {
        missingSet.add(varName);
        return full;
      }
      return value;
    });

  const renderedSubject = replaceAll(subjectTemplate).trim();
  const renderedBody = replaceAll(bodyTemplate);
  const missingVariables = Array.from(missingSet);

  return {
    renderedSubject,
    renderedBody,
    missingVariables,
    isValid: missingVariables.length === 0 && renderedSubject.length > 0 && renderedBody.trim().length > 0,
  };
}

/**
 * Detects whether a body already contains block-level HTML tags.
 */
export function looksLikeHtml(text: string): boolean {
  return /<\s*(p|div|br|a|ul|ol|li|strong|em|b|i|h[1-6]|table|span|blockquote)\b[^>]*>/i.test(text);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Converts plain-text emails (with paragraphs, line breaks, and bare URLs) into clean HTML.
 */
export function plainTextToHtml(plainText: string): string {
  const normalized = plainText.replace(/\r\n/g, '\n');
  const paragraphs = normalized.split(/\n{2,}/);
  const urlRegex = /(https?:\/\/[^\s<>"')]+)/g;

  return paragraphs
    .map((para) => {
      const escaped = escapeHtml(para);
      const linked = escaped.replace(urlRegex, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
      const withBreaks = linked.replace(/\n/g, '<br />');
      return `<p style="margin: 0 0 12px 0; line-height: 1.55;">${withBreaks}</p>`;
    })
    .join('\n');
}

/**
 * Appends an optional account signature cleanly to an HTML email body.
 */
export function appendSignatureHtml(bodyHtml: string, signatureHtml?: string | null, enabled = false): string {
  if (!enabled || !signatureHtml || !signatureHtml.trim()) {
    return bodyHtml;
  }
  return `${bodyHtml}\n<div class="email-signature" style="margin-top: 20px; padding-top: 12px; border-top: 1px solid #e2e8f0;">${signatureHtml}</div>`;
}
