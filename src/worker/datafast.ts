/**
 * Importing a website's history from DataFast, in the background.
 *
 * The owner pastes the DataFast API key in Settings → Import. DataFast has no bulk export, so the history
 * is rebuilt from its API the same way scripts/import-datafast.mjs does: daily totals, hourly totals for
 * hourly charts, and per-day breakdowns (sources, campaigns, pages, places, devices, goals). That is about
 * ten requests per day of history, and DataFast allows 60 a minute.
 *
 * A Worker run may only make a limited number of outside requests (50 on the free plan), so the import is a
 * job worked through in small steps: the cron job takes one step a minute, and while Settings is open the
 * page asks for steps back to back. Each step saves its data and the job's progress in one batch, so an
 * interrupted step loses nothing. A lease keeps two runs from working on the same job at once.
 *
 * Days the dashboard already has its own data for are never imported, so nothing is counted twice. The key
 * is stored encrypted while the job runs and deleted when it finishes.
 */
import { currencyDecimals } from '../shared/currency';
import { findKnownSource } from '../shared/sources';
import { forgetSite, getSite, type Env, type Site } from './env';
import { decryptSecret, encryptSecret } from './lib/crypto';

const API = 'https://datafa.st/api/v1';
/** DataFast allows 60 requests a minute per key. */
const GAP_MS = 1050;
/** Longer than the slowest step, so a step that died lets the next run take over soon after. */
const LEASE_MS = 90_000;
const DAY = 86_400_000;
/**
 * DataFast requests one run may make, under the per-run limit on outside requests with room for the database.
 * A page step does a day or so (~15 s); the cron job about three days a minute.
 */
export const RUN_BUDGET = { page: 20, cron: 36 } as const;
/**
 * Requests a day of breakdowns usually takes: one per endpoint, plus a couple for pagination. (The first day can
 * take a few more while it works out how DataFast wants pages and devices asked for; a run that runs short just
 * finishes that day next time.)
 */
const DAY_COST = 12;
/** Hourly totals for a week: one request, or seven when DataFast only answers day by day. */
const WEEK_COST = 8;
/** Temporary DataFast errors (rate limits, outages) in a row before the import gives up. */
const MAX_FAILURES = 6;

export class DataFastError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Worth trying again later (rate limit, outage), rather than a problem to fix. */
    public temporary = false,
  ) {
    super(message);
  }
}
class OutOfBudget extends Error {}

interface Job {
  site_id: string;
  status: 'running' | 'done' | 'error';
  phase: 'daily' | 'hourly' | 'breakdowns' | 'finish';
  api_key: string | null;
  source_site: string | null;
  revenue_unit: 'major' | 'minor';
  cursor: string | null;
  total_days: number;
  done_days: number;
  failures: number;
}

interface Cursor {
  sameTz: boolean;
  from?: string;
  to?: string;
  /** Days still needing breakdowns, in order; `next` is how far the import got. */
  todo?: string[];
  next?: number;
  /** Each day's totals [visitors, sessions, pageviews, revenue, payments], written once its breakdowns are in. */
  days?: Record<string, [number, number, number, number, number]>;
  hourFrom?: string;
  weekly?: boolean;
  /** Which way of asking for pages/devices worked, so later days skip the ones that don't. */
  winning?: Record<string, number>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- dates in the site's timezone

const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayIn = (tz: string, ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const canonical = (tz: string) => new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;

function parts(tz: string, ms: number) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
}
/** UTC ms of midnight starting `day` in `tz`. */
function midnight(day: string, tz: string) {
  const utc = Date.parse(day + 'T00:00:00Z');
  const p = parts(tz, utc);
  return utc - (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - utc);
}
/** The site-local hour a timestamp falls in, labelled like the dashboard's hourly buckets. */
function hourIn(tz: string, ms: number) {
  const p = parts(tz, ms);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}

// ---------- DataFast's API

class Client {
  calls = 0;
  private last = 0;
  constructor(
    private env: Env,
    private key: string,
    private sourceSite: string | null,
    private budget: number,
  ) {}

  left() {
    return this.budget - this.calls;
  }

  /** One request, paced to DataFast's limit. `soft`: a 4xx answer returns null instead of failing. */
  async get(path: string, params: Record<string, string | number | undefined> = {}, soft = false): Promise<any> {
    const url = new URL((this.env.DATAFAST_API_BASE ?? API).replace(/\/$/, '') + path);
    if (this.sourceSite) url.searchParams.set('websiteId', this.sourceSite);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 1; ; attempt++) {
      if (this.calls >= this.budget) throw new OutOfBudget();
      // Against a local stand-in for DataFast (testing only), there's no rate limit to respect.
      const wait = this.last + (this.env.DATAFAST_API_BASE ? 50 : GAP_MS) - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.calls++;
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json' } });
      } catch {
        if (attempt >= 2) throw new DataFastError(0, "Couldn't reach DataFast. Trying again shortly.", true);
        await sleep(2_000);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        // A short wait here; anything longer is left to the next run.
        if (attempt >= 2 || retryAfter > 15_000) {
          throw new DataFastError(res.status, res.status === 429 ? 'DataFast asked to slow down. Continuing in a minute.' : `DataFast answered ${res.status}. Trying again shortly.`, true);
        }
        await sleep(retryAfter || 5_000);
        continue;
      }
      const body: any = await res.json().catch(() => null);
      if (res.status === 401 || res.status === 403) {
        throw new DataFastError(401, "DataFast didn't accept that key. Use the website's API key (it starts with df_) from Settings → API in DataFast.");
      }
      if (soft && res.status >= 400 && res.status < 500) return null;
      if (!res.ok || !body || body.status === 'error') {
        throw new DataFastError(res.status, `DataFast ${path} answered ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 200)}`);
      }
      return body;
    }
  }

  /** Every row of a paginated endpoint. */
  async all(path: string, params: Record<string, string | number | undefined>) {
    const rows: any[] = [];
    for (let offset = 0; ; ) {
      const body = await this.get(path, { ...params, limit: 1000, offset });
      const data = rowsOf(body);
      rows.push(...data);
      offset += data.length;
      const total = body.pagination?.total;
      if (!data.length || typeof total !== 'number' || offset >= total) return rows;
    }
  }
}

/** A response's rows: `data` is usually the array itself, but some endpoints nest it one level down. */
function rowsOf(body: any): any[] {
  const d = body?.data;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') return (Object.values(d).find(Array.isArray) as any[]) ?? [];
  return [];
}

// ---------- DataFast's labels in the dashboard's terms

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const firstOf = (r: any, ...keys: string[]) => keys.map((k) => r[k]).find((v) => v !== undefined && v !== null && v !== '');

// Country names are compared loosely ("Trinidad and Tobago" = "Trinidad & Tobago"). The lookup is built only
// if a row ever needs it: most rows carry a flag emoji that spells the code.
const looseName = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/\s+sar\s+china$/, '').replace(/[^a-z]/g, '');
let countryCodes: Map<string, string> | null = null;
function codeForName(name: string) {
  if (!countryCodes) {
    countryCodes = new Map();
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        try {
          const n = names.of(code);
          if (n && n !== code && !countryCodes.has(looseName(n))) countryCodes.set(looseName(n), code);
        } catch {}
      }
    for (const [alias, code] of [
      ['united states of america', 'US'], ['usa', 'US'], ['uk', 'GB'], ['great britain', 'GB'], ['russian federation', 'RU'],
      ['south korea', 'KR'], ['republic of korea', 'KR'], ['czech republic', 'CZ'], ['turkey', 'TR'], ['türkiye', 'TR'],
      ['viet nam', 'VN'], ['vietnam', 'VN'], ['hong kong', 'HK'], ['macao', 'MO'], ['macau', 'MO'], ['ivory coast', 'CI'],
    ])
      countryCodes.set(looseName(alias), code);
  }
  return countryCodes.get(looseName(name));
}
/** Codes some sources use that aren't ISO 3166 (and so have no flag): the UK as "UK", Greece as "EL". */
const CODE_FIXES: Record<string, string> = { UK: 'GB', EL: 'GR' };
export function countryCode(row: any): string | null {
  const flag = [...String(row.image ?? '')].map((c) => (c.codePointAt(0) ?? 0) - 0x1f1e6);
  if (flag.length === 2 && flag.every((n) => n >= 0 && n < 26)) {
    const code = String.fromCharCode(65 + flag[0], 65 + flag[1]);
    return CODE_FIXES[code] ?? code;
  }
  const name = String(row.country ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(name)) return CODE_FIXES[name.toUpperCase()] ?? name.toUpperCase();
  return codeForName(name) ?? (name || null);
}

/** DataFast's referrer ("Direct / None", "Google", "news.ycombinator.com", a URL) as source + channel. */
export function sourceOf(referrer: unknown) {
  const raw = String(referrer ?? '').trim();
  if (!raw || /^direct\s*\/?\s*(none)?$/i.test(raw)) return { source: 'Direct/None', channel: 'Direct', domain: null as string | null };
  const host = raw.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
  const domain = /\.[a-z]{2,}$/.test(host) ? host.replace(/^www\./, '') : null;
  const known = findKnownSource(host) ?? findKnownSource(raw);
  if (known) return { source: known.name, channel: known.channel as string, domain: domain ?? known.domain };
  return { source: domain ?? raw, channel: 'Referral', domain };
}

type Money = (v: unknown) => number;

/**
 * Pages and devices sometimes come back empty for a plain `startAt=endAt=<day>` query on a day with traffic,
 * so those try equivalent ways of asking for exactly that local day and remember the first that works.
 */
const FIELDS: Record<string, string> = { '/analytics/pages': 'hostname,path,visitors,revenue,payments', '/analytics/devices': 'device,visitors,revenue,payments' };
async function allForDay(client: Client, path: string, day: string, tz: string, cursor: Cursor) {
  const fields = FIELDS[path];
  const variants = [
    { startAt: day, endAt: day, timezone: tz },
    { startAt: day, endAt: day, timezone: tz, fields },
    { startAt: new Date(midnight(day, tz)).toISOString(), endAt: new Date(midnight(addDays(day, 1), tz) - 1000).toISOString(), timezone: tz, fields },
    ...(cursor.sameTz ? [{ startAt: day, endAt: day, fields }] : []),
  ];
  const known = cursor.winning?.[path];
  if (known !== undefined && variants[known]) return client.all(path, variants[known]);
  for (const [i, params] of variants.entries()) {
    const rows = await client.all(path, params);
    if (rows.length) {
      cursor.winning = { ...cursor.winning, [path]: i };
      return rows;
    }
  }
  return [];
}

interface BreakdownRow {
  dim: string;
  label: string;
  extra: string | null;
  visitors: number;
  pageviews: number | null;
  revenue: number;
  customers: number;
}

/** One day's breakdowns, in the dashboard's dimensions. */
async function breakdownsFor(client: Client, day: string, tz: string, money: Money, cursor: Cursor) {
  const range = { startAt: day, endAt: day, timezone: tz };
  const out = new Map<string, BreakdownRow>();
  const add = (dim: string, label: string | null, r: any, extra: string | null = null) => {
    const k = `${dim}\u0000${label ?? ''}`;
    const row = out.get(k) ?? { dim, label: label ?? '', extra, visitors: 0, pageviews: null, revenue: 0, customers: 0 };
    row.visitors += num(r.visitors);
    if (r.pageviews !== undefined && r.pageviews !== null) row.pageviews = (row.pageviews ?? 0) + num(r.pageviews);
    row.revenue += money(r.revenue);
    row.customers += num(r.payments);
    row.extra = row.extra ?? extra;
    out.set(k, row);
  };

  for (const r of await client.all('/analytics/referrers', range)) {
    const s = sourceOf(r.referrer);
    add('source', s.source, r, s.domain);
    add('channel', s.channel, r);
  }
  for (const r of await client.all('/analytics/campaigns', range)) {
    const c = r.campaign ?? r;
    for (const [dim, field] of [['campaign', 'utm_campaign'], ['keyword', 'utm_term'], ['utm_source', 'utm_source'], ['utm_medium', 'utm_medium'], ['utm_content', 'utm_content'], ['ref', 'ref']]) {
      if (c[field]) add(dim, String(c[field]), r);
    }
  }
  for (const r of await allForDay(client, '/analytics/pages', day, tz, cursor)) {
    let path = String(firstOf(r, 'path', 'page', 'pathname', 'url') ?? '/');
    if (/^https?:\/\//i.test(path)) {
      try {
        path = new URL(path).pathname;
      } catch {}
    }
    add('page', path || '/', r);
  }
  for (const r of await client.all('/analytics/countries', range)) add('country', countryCode(r), r);
  for (const r of await client.all('/analytics/regions', range)) if (r.region) add('region', r.region, r);
  for (const r of await client.all('/analytics/cities', range)) if (r.city) add('city', r.city, r);
  for (const r of await allForDay(client, '/analytics/devices', day, tz, cursor)) add('device', cap(String(firstOf(r, 'device', 'type', 'name', 'device_type') ?? '')) || null, r);
  for (const r of await client.all('/analytics/browsers', range)) add('browser', r.browser || null, r);
  for (const r of await client.all('/analytics/operating-systems', range)) add('os', r.operating_system || null, r);
  for (const r of await client.all('/analytics/goals', range)) if (r.goal) add('goal', r.goal, { visitors: r.visitors, pageviews: r.completions });
  return [...out.values()];
}

// ---------- writing

/** INSERT OR REPLACE statements for many rows, within D1's limit of 100 bound values per statement. */
function insertMany(db: D1Database, table: string, cols: string[], rows: unknown[][]) {
  const per = Math.floor(100 / cols.length);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const values = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
    statements.push(db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES ${values}`).bind(...chunk.flat()));
  }
  return statements;
}

// ---------- the job

export interface ImportStatus {
  status: 'running' | 'done' | 'error';
  phase: Job['phase'];
  total_days: number;
  done_days: number;
  first_day: string | null;
  last_day: string | null;
  visitors: number;
  revenue: number;
  message: string | null;
  error: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

export async function importStatus(env: Env, siteId: string): Promise<ImportStatus | null> {
  return env.DB.prepare(
    `SELECT status, phase, total_days, done_days, first_day, last_day, visitors, revenue, message, error, started_at, updated_at, finished_at
     FROM imports WHERE site_id = ?`,
  )
    .bind(siteId)
    .first<ImportStatus>();
}

/**
 * Checks the key (and that DataFast's currency matches the site's) with one request, then saves the job.
 * The import itself happens in later steps.
 */
export async function startImport(env: Env, site: Site, input: { apiKey: string; sourceSite?: string | null; revenueUnit?: string }) {
  const key = input.apiKey.trim();
  if (!/^dft?_[\w-]{8,}$/.test(key)) throw new DataFastError(400, 'That doesn\'t look like a DataFast API key. It starts with df_ and is in DataFast under Settings → API.');
  const sourceSite = input.sourceSite?.trim() || null;
  if (key.startsWith('dft_') && !sourceSite) throw new DataFastError(400, 'An account token (dft_) also needs the DataFast website id.');
  const unit = input.revenueUnit === 'minor' ? 'minor' : 'major';

  const client = new Client(env, key, sourceSite, 3);
  const meta = rowsOf(await client.get('/analytics/metadata'))[0] ?? {};
  if (meta.currency && meta.currency !== site.currency) {
    throw new DataFastError(400, `DataFast reports revenue in ${meta.currency}, but ${site.name} uses ${site.currency}. Change the currency under General, then start again.`);
  }
  const cursor: Cursor = { sameTz: !meta.timezone || canonical(meta.timezone) === canonical(site.timezone) };
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO imports (site_id, origin, status, phase, api_key, source_site, revenue_unit, cursor, total_days, done_days,
       first_day, last_day, visitors, revenue, message, error, failures, started_at, updated_at, finished_at, lease_until)
     VALUES (?, 'datafast', 'running', 'daily', ?, ?, ?, ?, 0, 0, NULL, NULL, 0, 0, 'Reading daily totals from DataFast', NULL, 0, ?, ?, NULL, NULL)`,
  )
    .bind(site.id, await encryptSecret(env.SESSION_SECRET, key), sourceSite, unit, JSON.stringify(cursor), now, now)
    .run();
}

export async function cancelImport(env: Env, siteId: string) {
  await env.DB.prepare('DELETE FROM imports WHERE site_id = ?').bind(siteId).run();
}

/** One step of a running import: as much as `budget` DataFast requests allow. Safe to call from anywhere, any time. */
export async function runImportStep(env: Env, siteId: string, budget: number) {
  const now = Date.now();
  const job = await env.DB.prepare(
    `UPDATE imports SET lease_until = ? WHERE site_id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until < ?) RETURNING *`,
  )
    .bind(now + LEASE_MS, siteId, now)
    .first<Job>();
  if (!job) return; // finished, or another run has it right now
  const db = env.DB;
  const release = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    return db
      .prepare(`UPDATE imports SET ${keys.map((k) => `${k} = ?, `).join('')}lease_until = NULL, updated_at = ? WHERE site_id = ?`)
      .bind(...keys.map((k) => fields[k]), Date.now(), siteId);
  };
  const fail = (error: string) => release({ status: 'error', error, api_key: null, cursor: null, finished_at: Date.now() }).run();

  const site = await getSite(db, siteId);
  if (!site) return cancelImport(env, siteId);
  const key = job.api_key ? await decryptSecret(env.SESSION_SECRET, job.api_key) : null;
  if (!key) return fail("The saved DataFast key can't be read any more. Start the import again.");

  const tz = site.timezone;
  const decimals = currencyDecimals(site.currency);
  const money: Money = (v) => (job.revenue_unit === 'major' ? Math.round(num(v) * 10 ** decimals) : Math.round(num(v)));
  const client = new Client(env, key, job.source_site, budget);
  const cursor: Cursor = JSON.parse(job.cursor ?? '{"sameTz":true}');
  let phase = job.phase;

  try {
    if (phase === 'daily') {
      if (client.left() < 3) return void (await release({}).run());
      // Stop the day before the dashboard's own data starts (or yesterday, if it hasn't started).
      const own = await db.prepare('SELECT MIN(started_at) AS first FROM sessions WHERE site_id = ?').bind(siteId).first<{ first: number | null }>();
      const to = addDays(own?.first ? dayIn(tz, own.first) : dayIn(tz, Date.now()), -1);
      const series = await client.all('/analytics/timeseries', { interval: 'day', startAt: '2015-01-01', endAt: to, timezone: tz, fields: 'visitors,sessions,pageviews,revenue,payments' });
      const days: NonNullable<Cursor['days']> = {};
      for (const r of series) {
        const ts = String(r.timestamp);
        const day = isDay(ts) ? ts : dayIn(tz, Date.parse(ts));
        if (day <= to) days[day] = [num(r.visitors), num(r.sessions), num(r.pageviews), money(r.revenue), num(r.payments)];
      }
      const active = Object.keys(days).filter((d) => days[d][0] || days[d][2] || days[d][3]).sort();
      if (!active.length) {
        await release({ status: 'done', phase: 'finish', api_key: null, cursor: null, finished_at: Date.now(), message: `DataFast has no traffic for ${site.name} before ${addDays(to, 1)}, so there was nothing to import.` }).run();
        return;
      }
      const from = active[0];
      const wanted = Object.keys(days).filter((d) => d >= from).sort();
      const imported = new Set((await db.prepare('SELECT day FROM imported_daily WHERE site_id = ?').bind(siteId).all<{ day: string }>()).results.map((r) => r.day));
      const todo = wanted.filter((d) => !imported.has(d));
      Object.assign(cursor, { from, to, todo, next: 0, days: Object.fromEntries(todo.map((d) => [d, days[d]])), hourFrom: from, weekly: true });
      phase = todo.length ? 'hourly' : 'finish';
      await release({
        phase,
        cursor: JSON.stringify(cursor),
        total_days: todo.length,
        first_day: from,
        last_day: to,
        visitors: wanted.reduce((n, d) => n + days[d][0], 0),
        revenue: wanted.reduce((n, d) => n + days[d][3], 0),
        message: todo.length ? 'Hourly chart data' : 'Every day was already imported',
        failures: 0,
      }).run();
      return runImportStep(env, siteId, client.left());
    }

    if (phase === 'hourly') {
      const { from = '', to = '' } = cursor;
      const fields = 'visitors,pageviews,revenue,payments';
      while (cursor.hourFrom! <= to && client.left() >= WEEK_COST) {
        const start = cursor.hourFrom!;
        const end = addDays(start, 6) < to ? addDays(start, 6) : to;
        const hours = new Map<string, [number, number, number, number]>();
        const take = (rows: any[]) => {
          for (const r of rows) {
            const ts = String(r.timestamp);
            const hour = hourIn(tz, Date.parse(ts.includes('T') ? ts : `${ts}T00:00:00Z`));
            if (hour < `${from}T00:00` || hour > `${to}T23:00`) continue;
            const h = hours.get(hour) ?? [0, 0, 0, 0];
            hours.set(hour, [h[0] + num(r.visitors), h[1] + num(r.pageviews), h[2] + money(r.revenue), h[3] + num(r.payments)]);
          }
        };
        let got = false;
        if (cursor.weekly) {
          const body = await client.get('/analytics/timeseries', { interval: 'hour', startAt: start, endAt: end, timezone: tz, fields, limit: 1000 }, true);
          if (body && (body.interval ?? 'hour') === 'hour' && rowsOf(body).length > 7) {
            take(rowsOf(body));
            got = true;
          } else cursor.weekly = false; // DataFast answers day by day from here on
        }
        if (!got) {
          for (let day = start; day <= end; day = addDays(day, 1)) {
            const body = await client.get('/analytics/timeseries', { interval: 'hour', startAt: day, endAt: day, timezone: tz, fields, limit: 100 }, true);
            if (body) take(rowsOf(body));
          }
        }
        cursor.hourFrom = addDays(end, 1);
        const rows = [...hours].filter(([, h]) => h.some(Boolean)).map(([hour, h]) => [siteId, hour, ...h]);
        const weeks = Math.ceil((Date.parse(to) - Date.parse(from)) / (7 * DAY)) + 1;
        const doneWeeks = Math.round((Date.parse(cursor.hourFrom) - Date.parse(from)) / (7 * DAY));
        await db.batch([
          db.prepare('DELETE FROM imported_hourly WHERE site_id = ? AND hour >= ? AND hour <= ?').bind(siteId, `${start}T00:00`, `${end}T23:00`),
          ...insertMany(db, 'imported_hourly', ['site_id', 'hour', 'visitors', 'pageviews', 'revenue', 'payments'], rows),
          db.prepare('UPDATE imports SET cursor = ?, message = ?, failures = 0, updated_at = ? WHERE site_id = ?').bind(
            JSON.stringify(cursor),
            `Hourly chart data: ${Math.min(doneWeeks, weeks)} of ${weeks} weeks`,
            Date.now(),
            siteId,
          ),
        ]);
      }
      if (cursor.hourFrom! > to) {
        phase = 'breakdowns';
        await release({ phase, cursor: JSON.stringify(cursor), message: `Sources, pages and places: 0 of ${job.total_days} days` }).run();
        return runImportStep(env, siteId, client.left());
      }
      await release({}).run();
      return;
    }

    if (phase === 'breakdowns') {
      const todo = cursor.todo ?? [];
      while ((cursor.next ?? 0) < todo.length && client.left() >= DAY_COST) {
        const day = todo[cursor.next ?? 0];
        const rows = await breakdownsFor(client, day, tz, money, cursor);
        const total = cursor.days?.[day] ?? [0, 0, 0, 0, 0];
        cursor.next = (cursor.next ?? 0) + 1;
        delete cursor.days?.[day];
        await db.batch([
          db.prepare('DELETE FROM imported_breakdown WHERE site_id = ? AND day = ?').bind(siteId, day),
          ...insertMany(
            db,
            'imported_breakdown',
            ['site_id', 'dim', 'day', 'label', 'extra', 'visitors', 'pageviews', 'revenue', 'customers'],
            rows.map((r) => [siteId, r.dim, day, r.label, r.extra, r.visitors, r.pageviews, r.revenue, r.customers]),
          ),
          // The day's totals go in with its breakdowns: their presence is what marks the day as imported.
          db
            .prepare('INSERT OR REPLACE INTO imported_daily (site_id, day, visitors, sessions, pageviews, revenue, payments, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(siteId, day, ...total, 'datafast'),
          db
            .prepare('UPDATE imports SET cursor = ?, done_days = ?, message = ?, failures = 0, updated_at = ? WHERE site_id = ?')
            .bind(JSON.stringify(cursor), cursor.next, `Sources, pages and places: ${cursor.next} of ${todo.length} days`, Date.now(), siteId),
        ]);
      }
      if ((cursor.next ?? 0) >= todo.length) phase = 'finish';
      else return void (await release({}).run());
    }

    if (phase === 'finish') {
      const first = cursor.from;
      await db.batch([
        // "All time" starts at the site's creation date: reach back to the first imported day.
        ...(first ? [db.prepare('UPDATE sites SET created_at = MIN(created_at, ?) WHERE id = ?').bind(midnight(first, tz), siteId)] : []),
        release({
          status: 'done',
          phase: 'finish',
          api_key: null,
          cursor: null,
          finished_at: Date.now(),
          message: cursor.todo?.length ? `Imported ${cursor.todo.length} days of DataFast history` : 'Every day was already imported',
        }),
      ]);
      forgetSite(siteId);
    }
  } catch (e) {
    if (e instanceof OutOfBudget) {
      await release({ cursor: JSON.stringify(cursor) }).run();
    } else if (e instanceof DataFastError && e.temporary && job.failures + 1 < MAX_FAILURES) {
      await release({ cursor: JSON.stringify(cursor), message: e.message, failures: job.failures + 1 }).run();
    } else {
      await fail(e instanceof Error ? e.message : String(e));
    }
  }
}

/** The cron job's share: one step of the import that has waited longest. */
export async function runPendingImports(env: Env) {
  const now = Date.now();
  const next = await env.DB.prepare(
    `SELECT site_id FROM imports WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?) ORDER BY updated_at LIMIT 1`,
  )
    .bind(now)
    .first<{ site_id: string }>();
  if (next) await runImportStep(env, next.site_id, RUN_BUDGET.cron);
}
