import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Env, Site } from './env';
import { randomId, signToken, verifyToken } from './lib/crypto';

/**
 * Two modes:
 *  - self-hosted (default): one owner, password login (ADMIN_PASSWORD), sees every site.
 *  - hosted: set GOOGLE_CLIENT_ID/SECRET; anyone can sign in with Google, pays for a plan and sees only their own sites.
 *    Emails in ADMIN_EMAILS never pay and also own the sites created before accounts existed.
 */
export const isHosted = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  admin: boolean;
  paid: boolean;
  plan_status: string;
  plan_until: number | null;
  /** 'lifetime' | 'monthly' once they've paid. */
  plan: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  plan_status: string;
  plan_until: number | null;
  plan: string | null;
}

const SELF_HOSTED_OWNER: User = {
  id: 'admin',
  email: null,
  name: null,
  avatar: null,
  admin: true,
  paid: true,
  plan_status: 'active',
  plan_until: null,
  plan: null,
};

/**
 * The sign-in cookie. `__Host-` makes the browser refuse it unless it is Secure, for this exact host and
 * path / (no subdomain can set or read it); SameSite=Strict keeps it off every request another site starts.
 */
export const AUTH_COOKIE = 'oa_session';
/**
 * Over https (the deployed dashboard) cookies get the `__Host-` prefix and the Secure flag. Plain http only
 * happens in local development, where browsers refuse both, so there the bare name is used.
 */
const isHttps = (c: Context<AppEnv>) => new URL(c.req.url).protocol === 'https:';
export const cookieName = (c: Context<AppEnv>, base: string) => (isHttps(c) ? `__Host-${base}` : base);
/** How long a sign-in lasts on one device. */
export const SESSION_DAYS = 7;
const AUTH_DAYS = SESSION_DAYS;
const OAUTH_COOKIE = 'ml_oauth';

export function isAdminEmail(env: Env, email: string | null | undefined) {
  if (!email) return false;
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

/** Paid and not expired. plan_until NULL with an active plan means a one-time (lifetime) payment. */
export function planActive(status: string | null | undefined, until: number | null | undefined, now = Date.now()) {
  if (until) return until > now;
  return status === 'active';
}

/** Should events for this site still be recorded? (Self-hosted: always. Hosted: only while the owner has access.) */
export function siteOwnerActive(env: Env, site: Site & { owner_email?: string | null; owner_plan_status?: string | null; owner_plan_until?: number | null }) {
  if (!isHosted(env) || !site.owner_id) return true;
  return isAdminEmail(env, site.owner_email) || planActive(site.owner_plan_status, site.owner_plan_until);
}

export async function setSession(c: Context<AppEnv>, subject: string) {
  const expires = Date.now() + AUTH_DAYS * 86_400_000;
  setCookie(c, cookieName(c, AUTH_COOKIE), await signToken(c.env.SESSION_SECRET, `${subject}.${expires}`), {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Strict',
    path: '/',
    maxAge: AUTH_DAYS * 86_400,
  });
}

export function clearSession(c: Context<AppEnv>) {
  deleteCookie(c, cookieName(c, AUTH_COOKIE), { path: '/', secure: isHttps(c) });
}

/**
 * The owner's sessions carry this value; one whose value no longer matches is signed out. Changing it
 * ("Sign out everywhere") ends every session at once, on every device.
 */
export async function sessionEpoch(env: Env): Promise<string> {
  const read = () => env.DB.prepare("SELECT value FROM auth_state WHERE key = 'session_epoch'").first<{ value: string }>();
  const row = await read();
  if (row) return row.value;
  await env.DB.prepare("INSERT OR IGNORE INTO auth_state (key, value) VALUES ('session_epoch', ?)").bind(randomId(12)).run();
  return (await read())!.value;
}

export async function endAllSessions(env: Env) {
  await env.DB.prepare(
    "INSERT INTO auth_state (key, value) VALUES ('session_epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(randomId(12))
    .run();
}

export async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  if (!c.env.SESSION_SECRET) return null;
  const value = await verifyToken(c.env.SESSION_SECRET, getCookie(c, cookieName(c, AUTH_COOKIE)));
  if (!value) return null;
  const parts = value.split('.');
  if (Number(parts[parts.length - 1]) <= Date.now()) return null;
  // Self-hosted password session: "admin:<epoch>.<expires>"
  if (parts[0].startsWith('admin:')) {
    if (isHosted(c.env)) return null;
    return parts[0].slice('admin:'.length) === (await sessionEpoch(c.env)) ? SELF_HOSTED_OWNER : null;
  }
  // Hosted Google session: "u:<userId>.<expires>"
  if (!parts[0].startsWith('u:') || !isHosted(c.env)) return null;
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(parts[0].slice(2)).first<UserRow>();
  if (!row) return null;
  const admin = isAdminEmail(c.env, row.email);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar: row.avatar,
    admin,
    paid: admin || planActive(row.plan_status, row.plan_until),
    plan_status: row.plan_status,
    plan_until: row.plan_until,
    plan: row.plan,
  };
}

export const requireUser = async (c: Context<AppEnv>, next: Next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', user);
  await next();
};

/** SQL that limits `sites s` to the ones this user may see. */
export function siteAccessSql(env: Env, user: User): { sql: string; params: unknown[] } {
  if (!isHosted(env)) return { sql: '1 = 1', params: [] };
  if (user.admin) return { sql: '(s.owner_id = ? OR s.owner_id IS NULL)', params: [user.id] };
  return { sql: 's.owner_id = ?', params: [user.id] };
}

// ---------- Google sign-in (OAuth 2.0 authorization code flow)

function redirectUri(c: Context<AppEnv>) {
  return `${new URL(c.req.url).origin}/api/auth/google/callback`;
}

export async function googleStart(c: Context<AppEnv>) {
  if (!isHosted(c.env)) return c.text('Google sign-in is not configured', 404);
  const state = randomId(16);
  setCookie(c, OAUTH_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/api/auth/google',
    maxAge: 600,
  });
  const q = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
}

function decodeJwtPayload(jwt: string): Record<string, any> {
  const part = jwt.split('.')[1] ?? '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
}

export async function googleCallback(c: Context<AppEnv>) {
  if (!isHosted(c.env)) return c.text('Google sign-in is not configured', 404);
  const fail = (msg: string) => c.redirect(`/?login_error=${encodeURIComponent(msg)}`);
  const state = c.req.query('state');
  const expected = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: '/api/auth/google' });
  if (!state || !expected || state !== expected) return fail('Sign-in expired, please try again.');
  const code = c.req.query('code');
  if (!code) return fail(c.req.query('error') ?? 'Sign-in was cancelled.');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(c),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return fail('Google sign-in failed.');
  const tokens = await res.json<{ id_token?: string }>();
  if (!tokens.id_token) return fail('Google sign-in failed.');
  // The token came straight from Google over TLS, so its claims can be trusted; still check who it's for.
  const claims = decodeJwtPayload(tokens.id_token);
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issOk || claims.aud !== c.env.GOOGLE_CLIENT_ID || !claims.sub || !claims.email || claims.email_verified === false) {
    return fail('Google sign-in failed.');
  }
  const email = String(claims.email).toLowerCase();
  const now = Date.now();
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE google_sub = ? OR email = ?')
    .bind(claims.sub, email)
    .first<{ id: string }>();
  const id = existing?.id ?? randomId(10);
  const stmts = [
    existing
      ? c.env.DB.prepare('UPDATE users SET google_sub = ?, email = ?, name = ?, avatar = ? WHERE id = ?').bind(
          claims.sub,
          email,
          claims.name ?? null,
          claims.picture ?? null,
          id,
        )
      : c.env.DB.prepare('INSERT INTO users (id, google_sub, email, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
          id,
          claims.sub,
          email,
          claims.name ?? null,
          claims.picture ?? null,
          now,
        ),
  ];
  // The owner takes over the sites that existed before accounts were turned on.
  if (isAdminEmail(c.env, email)) stmts.push(c.env.DB.prepare('UPDATE sites SET owner_id = ? WHERE owner_id IS NULL').bind(id));
  await c.env.DB.batch(stmts);
  await setSession(c, `u:${id}`);
  // ?signup=1 lets the app record a "signup_completed" goal for brand-new accounts.
  return c.redirect(existing ? '/' : '/?signup=1');
}
