import crypto from 'node:crypto';

interface EncryptedPayload {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

function deriveAesKey(rawKey: string): Buffer {
  const trimmed = rawKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === 32) {
      return b64;
    }
  } catch {
    // Fallback to SHA-256 derivation
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

export function encryptSecret(plaintext: string, encryptionKey: string): string {
  const key = deriveAesKey(encryptionKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedPayload = {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
  return JSON.stringify(payload);
}

export function decryptSecret(ciphertextJson: string, encryptionKey: string): string {
  const payload = JSON.parse(ciphertextJson) as EncryptedPayload;
  if (!payload || payload.v !== 1 || !payload.iv || !payload.tag || !payload.data) {
    throw new Error('Invalid encrypted secret payload');
  }
  const key = deriveAesKey(encryptionKey);
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expectedHex = parts[5];
  if (!salt || !expectedHex || Number.isNaN(n) || Number.isNaN(r) || Number.isNaN(p)) {
    return false;
  }
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = crypto.scryptSync(password, salt, expectedBuf.length, { N: n, r, p });
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export function generateRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string, pepper = ''): string {
  return crypto.createHmac('sha256', pepper || 'outreach-token').update(token).digest('hex');
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function signTrackingPayload(id: string, purpose: 'open' | 'click' | 'unsub', trackingSecret: string): string {
  const message = `${purpose}:${id}`;
  const sig = crypto.createHmac('sha256', trackingSecret).update(message).digest('base64url');
  return `${id}.${sig}`;
}

export function verifyTrackingToken(
  signedToken: string,
  purpose: 'open' | 'click' | 'unsub',
  trackingSecret: string,
): string | null {
  const dotIdx = signedToken.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const id = signedToken.slice(0, dotIdx);
  const sig = signedToken.slice(dotIdx + 1);
  if (!id || !sig) return null;
  const expected = crypto
    .createHmac('sha256', trackingSecret)
    .update(`${purpose}:${id}`)
    .digest('base64url');
  return timingSafeEqualStrings(sig, expected) ? id : null;
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}
