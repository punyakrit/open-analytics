import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { handleEvent } from './collect';
import { forgetSite, type AppEnv, type Site } from './env';
import { clearSession, cookieName, currentUser, endAllSessions, googleCallback, googleStart, isHosted, requireUser, sessionEpoch, SESSION_DAYS, setSession, siteAccessSql } from './auth';
import { billingWebhook, checkout, planInfo } from './billing';
import { encryptSecret, passwordsMatch, randomId, signToken, verifyToken } from './lib/crypto';
import { getCookie, setCookie } from 'hono/cookie';
import { defaultSyncFrom, DodoError, listBrands, modeOfKey, storedKey, syncAllDodo, syncDodo } from './dodo';
import { handleDodoWebhook, handleGoalApi, handlePaymentApi, handleStripeWebhook, learnDodoProducts, rematchPayments } from './payments';
import { rememberOwnerDevice } from './owner';
import { CSP } from './security';
import { CRAWL_RETENTION_MS, crawlStats, handleCrawlApi } from './crawls';
import { breakdown, customers, funnel, makeCtx, ONLINE_EVENTS, ONLINE_MS, overview, realtime, sparklines, visitorProfile, visitors, type FunnelStep } from './stats';

const app = new Hono<AppEnv>();
// ---------- sign-in limits (see the login route)
/** Wrong passwords allowed from one network (IP) in LOGIN_WINDOW_MS before it is locked out. */
const MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
/** The first lock on a network lasts this long; each one after it twice as long as the last, up to a day. */
const FIRST_LOCK_MS = 15 * 60_000;
const LONGEST_LOCK_MS = 24 * 3_600_000;
/** Wrong passwords from all networks together, per window, before sign-in pauses for unknown browsers. */
const GLOBAL_MAX_FAILURES = 30;
/** Every sign-in answer takes at least this long, right or wrong, so timing reveals nothing and guessing is slow. */
const MIN_LOGIN_MS = 900;
/** Set after a successful sign-in: proof this browser has signed in before. It never signs anyone in by itself. */
const DEVICE_COOKIE = 'oa_device';

// Basic hardening for everything the Worker answers (API and app pages). Static files get the same
// headers from public/_headers. The tracking script and endpoint stay embeddable on customers' sites.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (c.req.path.startsWith('/api/')) {
    // Stats, settings and secrets must never sit in a shared or browser cache.
    if (c.req.path !== '/api/event' && !c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  } else {
    // Pages: the strict policy above, no framing (clickjacking), no access to camera, location and the like,
    // and a window of its own that pages it opens can't reach back into.
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', CSP);
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000');
  }
});

// ---------- per-IP rate limits

/**
 * Is this client over a per-IP limit? Uses Cloudflare's rate-limit bindings (wrangler.jsonc), whose
 * counters live per Cloudflare location, so the limits are approximate by design. Keyed on the
 * connecting IP Cloudflare saw, which a client can't forge with headers.
 */
async function overLimit(limiter: RateLimit | undefined, c: Context<AppEnv>, scope: string): Promise<boolean> {
  const ip = c.req.header('cf-connecting-ip');
  if (!limiter || !ip) return false;
  const { success } = await limiter.limit({ key: `${scope}:${ip}` });
  return !success;
}

// ---------- public: tracking, webhooks, server-side API

app.use('/api/event', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], maxAge: 86400 }));
// A real visitor sends a handful of events per page; one client flooding fake ones would inflate the
// stats and burn the free plan's daily D1 writes for every site, so it gets cut off instead.
app.post('/api/event', async (c) => ((await overLimit(c.env.EVENT_LIMIT, c, 'event')) ? c.body(null, 429) : handleEvent(c)));
// Webhooks are signed (HMAC) and time-stamped; anything else is rejected inside the handlers.
app.post('/api/webhooks/dodo/:siteId', handleDodoWebhook);
app.post('/api/webhooks/stripe/:siteId', handleStripeWebhook);
// Crawler reports are limited per site inside their handler instead: they all come from the site's one server, in bursts.
app.use('/api/v1/*', async (c, next) =>
  c.req.path !== '/api/v1/crawls' && (await overLimit(c.env.API_LIMIT, c, 'v1')) ? c.json({ error: 'Too many requests' }, 429) : next(),
);
app.post('/api/v1/payments', handlePaymentApi);
app.post('/api/v1/goals', handleGoalApi);
app.post('/api/v1/crawls', handleCrawlApi);

// ---------- login

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inMinutes = (ms: number) => {
  const m = Math.ceil(ms / 60_000);
  return m >= 90 ? `${Math.round(m / 60)} hours` : `${m} minute${m === 1 ? '' : 's'}`;
};

/**
 * Owner sign-in, with layered limits:
 *  1. Only the dashboard's own form: a same-origin JSON POST (no other site, no plain HTML form).
 *  2. Cloudflare's per-IP rate limit, before any database work.
 *  3. A network that gets the password wrong MAX_FAILURES times in 15 minutes is locked out: 15 minutes the
 *     first time, then twice as long each time, up to a day.
 *  4. If more than GLOBAL_MAX_FAILURES wrong passwords arrive from anywhere in 15 minutes (many networks
 *     guessing together), sign-in pauses, except for a browser that has signed in successfully before.
 *  5. Every answer takes at least MIN_LOGIN_MS, right or wrong.
 * Each attempt is recorded BEFORE the password is checked, in one batch with the counts, so a burst of
 * parallel guesses can't all slip under the limits.
 */
app.post('/api/auth/login', async (c) => {
  if (isHosted(c.env)) return c.json({ error: 'Use "Continue with Google".' }, 400);
  if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'Sign in from the dashboard itself.' }, 403);
  if (!(c.req.header('content-type') ?? '').startsWith('application/json')) return c.json({ error: 'Unsupported request.' }, 415);
  if (await overLimit(c.env.API_LIMIT, c, 'login')) return c.json({ error: 'Too many attempts. Try again in a minute.' }, 429);
  if (!c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) {
    return c.json({ error: 'Set ADMIN_PASSWORD and SESSION_SECRET (see README).' }, 500);
  }

  const now = Date.now();
  const answer = async (body: Record<string, unknown>, status: 200 | 401 | 429) => {
    await sleep(MIN_LOGIN_MS - (Date.now() - now));
    return c.json(body, status);
  };
  const db = c.env.DB;
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const country = c.req.header('cf-ipcountry') ?? null;

  const lock = await db.prepare('SELECT strikes, blocked_until FROM login_blocks WHERE ip = ?').bind(ip).first<{ strikes: number; blocked_until: number }>();
  if (lock && lock.blocked_until > now) {
    return answer({ error: `Too many wrong passwords from your network. Try again in ${inMinutes(lock.blocked_until - now)}.` }, 429);
  }
  const lockOut = async () => {
    const strikes = (lock?.strikes ?? 0) + 1;
    const until = now + Math.min(LONGEST_LOCK_MS, FIRST_LOCK_MS * 2 ** (strikes - 1));
    await db
      .prepare('INSERT INTO login_blocks (ip, strikes, blocked_until) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET strikes = excluded.strikes, blocked_until = excluded.blocked_until')
      .bind(ip, strikes, until)
      .run();
    return inMinutes(until - now);
  };

  const since = now - LOGIN_WINDOW_MS;
  const [, inserted, mine, everyone] = await db.batch([
    db.prepare('DELETE FROM login_attempts WHERE ts < ?').bind(now - 30 * 86_400_000),
    db.prepare('INSERT INTO login_attempts (ts, ip, ok, country) VALUES (?, ?, 0, ?) RETURNING id').bind(now, ip, country),
    // This network's wrong passwords in the window, since its last successful sign-in.
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM login_attempts
         WHERE ip = ? AND ok = 0 AND ts > MAX(?, COALESCE((SELECT MAX(ts) FROM login_attempts WHERE ip = ? AND ok = 1), 0))`,
      )
      .bind(ip, since, ip),
    db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND ts > ?').bind(since),
  ]);
  const attemptId = (inserted.results[0] as { id: number }).id;
  const failures = (mine.results[0] as { n: number }).n; // includes this attempt
  const failuresEverywhere = (everyone.results[0] as { n: number }).n;

  if (failures > MAX_FAILURES) return answer({ error: `Too many wrong passwords from your network. Try again in ${await lockOut()}.` }, 429);
  const knownDevice = !!(await verifyToken(c.env.SESSION_SECRET, getCookie(c, cookieName(c, DEVICE_COOKIE))));
  if (failuresEverywhere > GLOBAL_MAX_FAILURES && !knownDevice) {
    return answer({ error: 'Sign-in is paused for a few minutes after many wrong passwords. Try again later.' }, 429);
  }

  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (typeof password !== 'string' || !password || password.length > 1000 || !(await passwordsMatch(password, c.env.ADMIN_PASSWORD))) {
    if (failures >= MAX_FAILURES) return answer({ error: `Wrong password. Sign-in from your network is locked for ${await lockOut()}.` }, 429);
    const left = MAX_FAILURES - failures;
    return answer({ error: `Wrong password. ${left} ${left === 1 ? 'try' : 'tries'} left before sign-in locks for 15 minutes.` }, 401);
  }

  await db.batch([
    db.prepare('UPDATE login_attempts SET ok = 1 WHERE id = ?').bind(attemptId),
    db.prepare('DELETE FROM login_blocks WHERE ip = ?').bind(ip),
  ]);
  await setSession(c, `admin:${await sessionEpoch(c.env)}`);
  setCookie(c, cookieName(c, DEVICE_COOKIE), await signToken(c.env.SESSION_SECRET, `device.${randomId(12)}`), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
    maxAge: 365 * 86_400,
  });
  return answer({ ok: true }, 200);
});

/** "203.0.113.42" → "203.0.x.x"; IPv6 keeps its first two groups. Enough to tell networks apart, not to locate anyone. */
function maskIp(ip: string) {
  if (ip.includes('.')) return ip.split('.').slice(0, 2).join('.') + '.x.x';
  if (ip.includes(':')) return ip.split(':').slice(0, 2).join(':') + ':…';
  return ip;
}

// Recent sign-in attempts and the limits in force, for Settings → Sign-in security.
app.get('/api/auth/activity', requireUser, async (c) => {
  if (!c.get('user').admin) return c.json({ error: 'not found' }, 404);
  const now = Date.now();
  const me = c.req.header('cf-connecting-ip') ?? '';
  const [rows, failed, locked] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT ts, ip, ok, country FROM login_attempts ORDER BY ts DESC LIMIT 25'),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND ts > ?').bind(now - 86_400_000),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_blocks WHERE blocked_until > ?').bind(now),
  ]);
  return c.json({
    attempts: (rows.results as { ts: number; ip: string; ok: number; country: string | null }[]).map((r) => ({
      ts: r.ts,
      ok: !!r.ok,
      country: r.country,
      network: maskIp(r.ip),
      yours: r.ip === me,
    })),
    failedLastDay: (failed.results[0] as { n: number }).n,
    lockedNetworks: (locked.results[0] as { n: number }).n,
    limits: { maxFailures: MAX_FAILURES, windowMinutes: LOGIN_WINDOW_MS / 60_000, firstLockMinutes: FIRST_LOCK_MS / 60_000, sessionDays: SESSION_DAYS },
  });
});

// Ends every signed-in session, this one included.
app.post('/api/auth/logout-all', requireUser, async (c) => {
  if (!c.get('user').admin) return c.json({ error: 'not found' }, 404);
  await endAllSessions(c.env);
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/auth/google', googleStart);
app.get('/api/auth/google/callback', googleCallback);

app.post('/api/auth/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const user = await currentUser(c);
  if (user) c.executionCtx.waitUntil(rememberOwnerDevice(c, user).catch(() => {}));
  return c.json({ loggedIn: !!user, hosted: isHosted(c.env), user });
});

// ---------- billing (hosted mode)

app.get('/api/public/plan', async (c) => c.json(await planInfo(c.env)));
app.post('/api/billing/webhook', billingWebhook);
app.get('/api/billing/checkout', requireUser, checkout);

// ---------- dashboard API (login required)

app.use('/api/sites', requireUser);
app.use('/api/sites/*', requireUser);

const loadSite = async (c: Context<AppEnv>, next: Next) => {
  const access = siteAccessSql(c.env, c.get('user'));
  const site = await c.env.DB.prepare(`SELECT s.* FROM sites s WHERE s.id = ? AND ${access.sql}`)
    .bind(c.req.param('id'), ...access.params)
    .first<Site>();
  if (!site) return c.json({ error: 'site not found' }, 404);
  c.set('site', site);
  await next();
};
app.use('/api/sites/:id', loadSite);
app.use('/api/sites/:id/*', loadSite);

function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const mask = (secret: string | null | undefined) => (secret ? '••••••••' : null);
/** A site as the owner's browser sees it: secrets masked, the stored Dodo API key left out entirely. */
const publicSite = ({ dodo_api_key, ...s }: Site) => ({
  ...s,
  dodo_webhook_secret: mask(s.dodo_webhook_secret),
  stripe_webhook_secret: mask(s.stripe_webhook_secret),
  dodo_api_connected: !!dodo_api_key,
});

app.get('/api/sites', async (c) => {
  const now = Date.now();
  const access = siteAccessSql(c.env, c.get('user'));
  const [sites, stats, live] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT s.* FROM sites s WHERE ${access.sql} ORDER BY s.created_at`).bind(...access.params),
    c.env.DB.prepare(`SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors FROM sessions WHERE started_at > ? GROUP BY site_id`).bind(now - 86_400_000),
    // Online = opened a page or completed a goal in the last 10 minutes (see ONLINE_MS).
    c.env.DB.prepare(`SELECT site_id, COUNT(DISTINCT visitor_id) AS online FROM events WHERE ts > ? AND type IN ${ONLINE_EVENTS} GROUP BY site_id`).bind(
      now - ONLINE_MS,
    ),
  ]);
  const by = new Map((stats.results as any[]).map((r) => [r.site_id, r]));
  const onlineBy = new Map((live.results as any[]).map((r) => [r.site_id, r.online as number]));
  return c.json(
    (sites.results as unknown as Site[]).map((s) => ({
      ...publicSite(s),
      visitors24h: by.get(s.id)?.visitors ?? 0,
      online: onlineBy.get(s.id) ?? 0,
    })),
  );
});

// Every site's totals and sparkline for the all-websites view.
app.use('/api/sites-overview', requireUser);
app.get('/api/sites-overview', async (c) => {
  const access = siteAccessSql(c.env, c.get('user'));
  const rows = await c.env.DB.prepare(`SELECT s.id FROM sites s WHERE ${access.sql}`).bind(...access.params).all<{ id: string }>();
  return c.json(await sparklines(c.env.DB, rows.results.map((r) => r.id), c.req.query('period') ?? '30d'));
});

app.post('/api/sites', async (c) => {
  const user = c.get('user');
  if (isHosted(c.env) && !user.paid) return c.json({ error: 'Choose a plan to add websites.' }, 402);
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const domain = cleanDomain(b.domain ?? '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return c.json({ error: 'Enter a domain like example.com' }, 400);
  if (b.timezone && !validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
  const tz = b.timezone || 'UTC';
  const site: Site = {
    id: randomId(8),
    name: (b.name || domain).slice(0, 100),
    domain,
    timezone: tz,
    currency: (b.currency || 'USD').toUpperCase().slice(0, 3),
    api_key: 'ml_' + randomId(16),
    dodo_webhook_secret: null,
    created_at: Date.now(),
  };
  await c.env.DB.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, dodo_webhook_secret, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, null, site.created_at, isHosted(c.env) ? user.id : null)
    .run();
  return c.json(publicSite(site));
});

app.get('/api/sites/:id', (c) => c.json(publicSite(c.get('site'))));

app.patch('/api/sites/:id', async (c) => {
  const site = c.get('site');
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const next = { ...site };
  if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 100);
  if (typeof b.domain === 'string') {
    const d = cleanDomain(b.domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return c.json({ error: 'Enter a domain like example.com' }, 400);
    next.domain = d;
  }
  if (typeof b.timezone === 'string') {
    if (!validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
    next.timezone = b.timezone;
  }
  if (typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency)) next.currency = b.currency.toUpperCase();
  if (typeof b.dodo_webhook_secret === 'string' && !b.dodo_webhook_secret.includes('•')) {
    next.dodo_webhook_secret = b.dodo_webhook_secret.trim() || null;
  }
  if (typeof b.stripe_webhook_secret === 'string' && !b.stripe_webhook_secret.includes('•')) {
    next.stripe_webhook_secret = b.stripe_webhook_secret.trim() || null;
  }
  if (typeof b.dodo_product_ids === 'string') {
    const ids = b.dodo_product_ids.split(/[\s,]+/).filter((x) => /^pdt_[\w-]+$/.test(x));
    next.dodo_product_ids = ids.join(',') || null;
  }
  const pub: unknown = b.public;
  if (typeof pub === 'boolean' || pub === 0 || pub === 1) next.public = pub ? 1 : 0;
  await c.env.DB.prepare(
    'UPDATE sites SET name = ?, domain = ?, timezone = ?, currency = ?, dodo_webhook_secret = ?, dodo_product_ids = ?, stripe_webhook_secret = ?, public = ? WHERE id = ?',
  )
    .bind(
      next.name,
      next.domain,
      next.timezone,
      next.currency,
      next.dodo_webhook_secret,
      next.dodo_product_ids ?? null,
      next.stripe_webhook_secret ?? null,
      next.public ? 1 : 0,
      site.id,
    )
    .run();
  forgetSite(site.id);
  return c.json(publicSite(next));
});

// ---------- Dodo through its API (dodo.ts): connect a key, pick the brand, sync

const dodoError = (c: Context<AppEnv>, e: unknown) =>
  c.json({ error: (e as Error).message }, e instanceof DodoError && e.status >= 400 && e.status < 500 ? 400 : 502);

/** Check a pasted key against Dodo, keep it encrypted, and return the business's brands to choose from. */
app.post('/api/sites/:id/dodo/connect', async (c) => {
  const site = c.get('site');
  const { apiKey } = await c.req.json<{ apiKey?: string }>().catch(() => ({ apiKey: undefined }));
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key || key.length > 500 || /\s/.test(key)) return c.json({ error: 'Paste the API key from Dodo (Developer → API keys).' }, 400);
  let mode = modeOfKey(key);
  let brands;
  try {
    brands = await listBrands(c.env, key, mode);
  } catch (e) {
    // An unprefixed (older) key may belong to test mode.
    if (!(e instanceof DodoError && e.status === 401 && !key.startsWith('dodo_'))) return dodoError(c, e);
    try {
      mode = 'test';
      brands = await listBrands(c.env, key, mode);
    } catch (e2) {
      return dodoError(c, e2);
    }
  }
  // One brand: nothing to choose. Several: the owner picks; no brand is assumed.
  const only = brands.length === 1 ? brands[0] : null;
  await c.env.DB.prepare(
    `UPDATE sites SET dodo_api_key = ?, dodo_api_mode = ?, dodo_brand_id = ?, dodo_brand_name = ?, dodo_synced_at = NULL, dodo_sync_error = NULL,
       dodo_sync_from = COALESCE(dodo_sync_from, ?) WHERE id = ?`,
  )
    .bind(await encryptSecret(c.env.SESSION_SECRET, key), mode, only?.brand_id ?? null, only ? (only.name ?? only.statement_descriptor) : null, await defaultSyncFrom(c.env, site), site.id)
    .run();
  forgetSite(site.id);
  return c.json({ mode, brands, brand_id: only?.brand_id ?? null });
});

app.get('/api/sites/:id/dodo/brands', async (c) => {
  const site = c.get('site');
  const key = await storedKey(c.env, site);
  if (!key) return c.json({ error: 'Connect a Dodo API key first.' }, 400);
  try {
    return c.json(await listBrands(c.env, key, site.dodo_api_mode === 'test' ? 'test' : 'live'));
  } catch (e) {
    return dodoError(c, e);
  }
});

/** Choose which Dodo brand is this website, then pull its payments straight away. */
app.post('/api/sites/:id/dodo/brand', async (c) => {
  const site = c.get('site');
  const key = await storedKey(c.env, site);
  if (!key) return c.json({ error: 'Connect a Dodo API key first.' }, 400);
  const { brandId } = await c.req.json<{ brandId?: string }>().catch(() => ({ brandId: undefined }));
  let brands;
  try {
    brands = await listBrands(c.env, key, site.dodo_api_mode === 'test' ? 'test' : 'live');
  } catch (e) {
    return dodoError(c, e);
  }
  const brand = brands.find((b) => b.brand_id === brandId);
  if (!brand) return c.json({ error: 'That brand is not in this Dodo account.' }, 400);
  await c.env.DB.prepare('UPDATE sites SET dodo_brand_id = ?, dodo_brand_name = ?, dodo_synced_at = NULL, dodo_sync_error = NULL WHERE id = ?')
    .bind(brand.brand_id, brand.name ?? brand.statement_descriptor, site.id)
    .run();
  forgetSite(site.id);
  const fresh = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(site.id).first<Site>();
  try {
    return c.json({ ok: true, ...(await syncDodo(c.env, fresh!)) });
  } catch (e) {
    return c.json({ ok: true, syncError: (e as Error).message });
  }
});

app.post('/api/sites/:id/dodo/sync', async (c) => {
  try {
    return c.json(await syncDodo(c.env, c.get('site')));
  } catch (e) {
    return dodoError(c, e);
  }
});

/** Forget the key and brand. Payments already pulled stay. */
app.delete('/api/sites/:id/dodo', async (c) => {
  await c.env.DB.prepare(
    'UPDATE sites SET dodo_api_key = NULL, dodo_api_mode = NULL, dodo_brand_id = NULL, dodo_brand_name = NULL, dodo_synced_at = NULL, dodo_sync_error = NULL WHERE id = ?',
  )
    .bind(c.get('site').id)
    .run();
  forgetSite(c.get('site').id);
  return c.json({ ok: true });
});

app.post('/api/sites/:id/rotate-key', async (c) => {
  const key = 'ml_' + randomId(16);
  await c.env.DB.prepare('UPDATE sites SET api_key = ? WHERE id = ?').bind(key, c.get('site').id).run();
  return c.json({ api_key: key });
});

app.delete('/api/sites/:id', async (c) => {
  const id = c.get('site').id;
  await c.env.DB.batch(
    // Everything stored for the site, so deleting it really removes its visitors' data.
    ['events', 'sessions', 'visitors', 'payments', 'funnels', 'payment_claims', 'pending_payments', 'dodo_products', 'crawls', 'imported_daily', 'imported_breakdown', 'imported_hourly'].map((t) =>
      c.env.DB.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(id),
    ).concat(c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id)),
  );
  forgetSite(id);
  return c.json({ ok: true });
});

// ---------- stats

// Aggregate stats only. Shared by the owner's dashboard and the public read-only one.
const overviewHandler = async (c: Context<AppEnv>) => c.json(await overview(makeCtx(c)));
const crawlsHandler = async (c: Context<AppEnv>) => c.json(await crawlStats(makeCtx(c), c.req.query('kind')));
const breakdownHandler = async (c: Context<AppEnv>) => {
  try {
    return c.json(await breakdown(makeCtx(c), c.req.query('dim') ?? 'source', Number(c.req.query('limit')) || 100));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
};
const funnelsHandler = async (c: Context<AppEnv>) => {
  const res = await c.env.DB.prepare('SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all();
  return c.json(res.results.map((f: any) => ({ ...f, steps: JSON.parse(f.steps) })));
};
const funnelStatsHandler = async (c: Context<AppEnv>) => {
  const f = await c.env.DB.prepare('SELECT * FROM funnels WHERE id = ? AND site_id = ?')
    .bind(c.req.param('fid'), c.get('site').id)
    .first<{ steps: string }>();
  if (!f) return c.json({ error: 'funnel not found' }, 404);
  return c.json(await funnel(makeCtx(c), JSON.parse(f.steps)));
};

app.get('/api/sites/:id/overview', overviewHandler);
app.get('/api/sites/:id/crawls', crawlsHandler);
app.get('/api/sites/:id/breakdown', breakdownHandler);

// Dodo payments that couldn't be placed on a site yet, grouped by product.
app.get('/api/sites/:id/pending-payments', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT product_id, COUNT(*) AS count, SUM(json_extract(payload, '$.amount')) AS amount, MAX(json_extract(payload, '$.currency')) AS currency
     FROM pending_payments WHERE site_id = ? GROUP BY product_id ORDER BY MAX(ts) DESC`,
  )
    .bind(c.get('site').id)
    .all();
  return c.json(r.results);
});
app.post('/api/sites/:id/pending-payments', async (c) => {
  const b = await c.req.json<{ product_id?: string }>().catch(() => ({}) as { product_id?: string });
  if (!b.product_id || !/^pdt_[\w-]+$/.test(b.product_id)) return c.json({ error: 'product_id is required' }, 400);
  await learnDodoProducts(c.env.DB, c.get('site'), [b.product_id]);
  return c.json({ ok: true });
});
app.post('/api/sites/:id/rematch', async (c) => c.json(await rematchPayments(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/realtime', async (c) => c.json(await realtime(c.env.DB, c.get('site'))));
app.get('/api/sites/:id/customers', async (c) => c.json(await customers(makeCtx(c))));
app.get('/api/sites/:id/visitors', async (c) => c.json(await visitors(makeCtx(c))));
app.get('/api/sites/:id/visitors/:vid', async (c) =>
  c.json(await visitorProfile(c.env.DB, c.get('site'), c.req.param('vid'))),
);

app.get('/api/sites/:id/funnels', funnelsHandler);

app.post('/api/sites/:id/funnels', async (c) => {
  const b = await c.req.json<{ name?: string; steps?: FunnelStep[] }>().catch(() => ({}) as { name?: string; steps?: FunnelStep[] });
  const steps = (b.steps ?? [])
    .filter((s) => (s.type === 'page' || s.type === 'goal') && typeof s.value === 'string' && s.value.trim())
    .slice(0, 10)
    .map((s) => ({ type: s.type, value: s.value.trim().slice(0, 200) }));
  if (!b.name?.trim() || steps.length < 2) return c.json({ error: 'A funnel needs a name and at least 2 steps' }, 400);
  const id = randomId(8);
  await c.env.DB.prepare('INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('site').id, b.name.trim().slice(0, 100), JSON.stringify(steps), Date.now())
    .run();
  return c.json({ id, name: b.name.trim(), steps });
});

app.delete('/api/sites/:id/funnels/:fid', async (c) => {
  await c.env.DB.prepare('DELETE FROM funnels WHERE id = ? AND site_id = ?').bind(c.req.param('fid'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/funnels/:fid/stats', funnelStatsHandler);

// ---------- public, read-only dashboards
//
// Sites the owner marked "public" in their settings can be viewed by anyone, without logging in.
// Only aggregate stats are served here: no settings, API keys, webhook secrets, visitor names or
// emails, customer lists or per-visitor timelines, and nothing that writes.

const publicFields = (s: Site) => ({ id: s.id, name: s.name, domain: s.domain, timezone: s.timezone, currency: s.currency, created_at: s.created_at });

/** A short edge cache, so a busy public page can't burn through the free D1 read quota. */
/**
 * The copy sent to the browser is never cacheable. Only Cloudflare's own edge cache keeps it (a minute).
 * A `public, max-age` header here used to be stretched to 4 hours by the zone's Browser Cache TTL, so a
 * browser kept serving e.g. "today: 0 visitors" from just after midnight long after visits came in.
 */
const forBrowser = (r: Response) => {
  const out = new Response(r.body, r);
  out.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return out;
};
const publicCache = async (c: Context<AppEnv>, next: Next) => {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(c.req.url);
  const hit = await cache.match(key);
  if (hit) return forBrowser(hit);
  // Only cache misses reach the database, and changing the query string forces a miss, so limit those.
  if (await overLimit(c.env.API_LIMIT, c, 'public')) return c.json({ error: 'Too many requests' }, 429);
  await next();
  if (c.res.status !== 200) return;
  const stored = new Response(c.res.body, c.res);
  stored.headers.set('Cache-Control', `public, max-age=${c.req.path.endsWith('/realtime') ? 10 : 60}`);
  c.executionCtx.waitUntil(cache.put(key, stored.clone()));
  c.res = forBrowser(stored);
};

const loadPublicSite = async (c: Context<AppEnv>, next: Next) => {
  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ? AND public = 1').bind(c.req.param('id')).first<Site>();
  if (!site) return c.json({ error: 'site not found' }, 404);
  c.set('site', site);
  await next();
};

app.get('/api/public/sites', publicCache, async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM sites WHERE public = 1 ORDER BY created_at').all<Site>();
  return c.json(r.results.map(publicFields));
});
// Totals and sparklines for the public landing page's website cards.
app.get('/api/public/sites-overview', publicCache, async (c) => {
  const r = await c.env.DB.prepare('SELECT id FROM sites WHERE public = 1').all<{ id: string }>();
  return c.json(await sparklines(c.env.DB, r.results.map((s) => s.id), c.req.query('period') ?? '30d'));
});
app.use('/api/public/sites/:id', publicCache, loadPublicSite);
app.use('/api/public/sites/:id/*', publicCache, loadPublicSite);
app.get('/api/public/sites/:id', (c) => c.json(publicFields(c.get('site'))));
app.get('/api/public/sites/:id/overview', overviewHandler);
app.get('/api/public/sites/:id/crawls', crawlsHandler);
app.get('/api/public/sites/:id/breakdown', breakdownHandler);
app.get('/api/public/sites/:id/funnels', funnelsHandler);
app.get('/api/public/sites/:id/funnels/:fid/stats', funnelStatsHandler);
// The live map: where people are and which pages they open. No names, emails, payments or amounts.
app.get('/api/public/sites/:id/realtime', async (c) => {
  const r = await realtime(c.env.DB, c.get('site'));
  return c.json({
    ...r,
    visitors: (r.visitors as any[]).map(({ name: _n, email: _e, spent: _s, ...v }) => v),
    feed: r.feed.filter((f) => f.type === 'pageview' || f.type === 'goal').map((f) => ({ ...f, name: null })),
  });
});

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// Static files are served before the Worker runs. What reaches here is a client-side route, or a page that doesn't exist.
const APP_PAGES = /^\/(admin-login|billing(\/.*)?|site\/[\w-]+(\/settings|\/live)?\/?)$/;

app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  const index = await c.env.ASSETS.fetch(new URL('/', c.req.url));
  const headers = new Headers(index.headers);
  // A private dashboard: nothing here should be in search results.
  headers.set('X-Robots-Tag', 'noindex');
  const status = APP_PAGES.test(path) ? 200 : 404;
  return new Response(index.body, { status, headers });
});

export default {
  fetch: app.fetch,
  // Every 10 minutes (wrangler.jsonc): pull new Dodo payments for sites connected by API key.
  async scheduled(_controller: ScheduledController, env: AppEnv['Bindings'], ctx: ExecutionContext) {
    ctx.waitUntil(syncAllDodo(env));
    ctx.waitUntil(env.DB.prepare('DELETE FROM crawls WHERE ts < ?').bind(Date.now() - CRAWL_RETENTION_MS).run());
  },
};
