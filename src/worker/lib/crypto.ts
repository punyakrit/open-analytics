const enc = new TextEncoder();

export function randomId(bytes = 12): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, bytes * 2);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * Verify a Standard Webhooks signature (used by Dodo Payments).
 * Signed content is `${id}.${timestamp}.${body}`, HMAC-SHA256 with the base64 secret after `whsec_`.
 */
export async function verifyStandardWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  now = Date.now(),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 5 * 60) return false;
  let key: Uint8Array<ArrayBuffer>;
  try {
    key = b64ToBytes(secret.startsWith('whsec_') ? secret.slice(6) : secret);
  } catch {
    return false;
  }
  const expected = bytesToB64(await hmac(key, `${id}.${timestamp}.${body}`));
  return signature
    .split(' ')
    .map((s) => s.split(',')[1] ?? '')
    .some((sig) => safeEqual(sig, expected));
}

/**
 * Verify a Stripe webhook signature. The `Stripe-Signature` header is `t=<unix>,v1=<hex>[,v1=<hex>]`;
 * signed content is `${t}.${body}`, HMAC-SHA256 with the whole `whsec_...` secret as the key.
 */
export async function verifyStripeWebhook(secret: string, header: string | null, body: string, now = Date.now()): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1] ?? '';
  if (!/^\d+$/.test(t) || Math.abs(now / 1000 - Number(t)) > 5 * 60) return false;
  const mac = new Uint8Array(await hmac(enc.encode(secret.trim()), `${t}.${body}`));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  return parts.some(([k, v]) => k === 'v1' && !!v && safeEqual(v, expected));
}

/**
 * Encrypt a third-party credential (a Dodo API key) for storage in D1. AES-GCM with a key derived from
 * SESSION_SECRET, so a copy of the database alone doesn't reveal it. Rotating SESSION_SECRET makes stored
 * credentials unreadable: they then just need entering again.
 *
 * v2 is the current format. v1 (the project's former name in the key label) is still read so keys saved before
 * the rename keep working; storedKey() in dodo.ts rewrites each one as v2 the first time it reads it.
 */
const KEY_LABEL = { v1: 'minilytics', v2: 'open-analytics' } as const;
type SecretVersion = keyof typeof KEY_LABEL;
async function secretKey(sessionSecret: string, version: SecretVersion): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`${KEY_LABEL[version]}:stored-credential:${sessionSecret}`));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export const isOldSecretFormat = (stored: string) => stored.startsWith('v1:');
export async function encryptSecret(sessionSecret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(sessionSecret, 'v2'), enc.encode(plain));
  return `v2:${bytesToB64(iv.buffer)}:${bytesToB64(box)}`;
}
export async function decryptSecret(sessionSecret: string, stored: string): Promise<string | null> {
  const [v, iv, box] = stored.split(':');
  if (!(v in KEY_LABEL) || !iv || !box) return null;
  try {
    const key = await secretKey(sessionSecret, v as SecretVersion);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(iv) }, key, b64ToBytes(box));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Sign a value for the dashboard login cookie. */
export async function signToken(secret: string, value: string): Promise<string> {
  const sig = bytesToB64(await hmac(enc.encode(secret), value)).replace(/=+$/, '');
  return `${value}.${sig}`;
}

export async function verifyToken(secret: string, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const value = token.slice(0, i);
  const expected = await signToken(secret, value);
  return safeEqual(expected, token) ? value : null;
}

/**
 * Constant-time password check. Both sides are hashed to 32 bytes first, so the time taken reveals
 * neither which characters matched nor how long the real password is.
 */
export async function passwordsMatch(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return safeEqual(bytesToB64(x), bytesToB64(y));
}
