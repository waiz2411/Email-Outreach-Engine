const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|authorization|cookie|encryption|access_token|refresh_token|creds|key|body|html|renderedBody)/i;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[Truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.startsWith('Bearer ')) return 'Bearer [REDACTED]';
    return value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value;
  }
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => sanitizeValue(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      output[k] = '[REDACTED]';
    } else {
      output[k] = sanitizeValue(v, depth + 1);
    }
  }
  return output;
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>) {
    if (process.env.NODE_ENV === 'test') return;
    const entry = {
      level: 'info',
      ts: new Date().toISOString(),
      msg: message,
      ...(meta ? { meta: sanitizeValue(meta) } : {}),
    };
    console.log(JSON.stringify(entry));
  },
  warn(message: string, meta?: Record<string, unknown>) {
    const entry = {
      level: 'warn',
      ts: new Date().toISOString(),
      msg: message,
      ...(meta ? { meta: sanitizeValue(meta) } : {}),
    };
    console.warn(JSON.stringify(entry));
  },
  error(message: string, meta?: Record<string, unknown>) {
    const entry = {
      level: 'error',
      ts: new Date().toISOString(),
      msg: message,
      ...(meta ? { meta: sanitizeValue(meta) } : {}),
    };
    console.error(JSON.stringify(entry));
  },
};
