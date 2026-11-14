#!/usr/bin/env node
/**
 * Import a website's history from DataFast (https://datafa.st) into a Open Analytics site.
 *
 * DataFast's API has no raw export, so this imports what it does offer: per-day totals
 * (visitors, sessions, pageviews, revenue, payments) and per-day breakdowns by source,
 * channel, campaign, page, country, region, city, device, browser, OS and goal. They are
 * stored in imported_daily / imported_breakdown and the dashboard adds them to its numbers.
 *
 * It only imports days BEFORE Open Analytics' own data for the site starts, so nothing is counted
 * twice. Run it after the Open Analytics script is live on the site; run it again any time and it
 * picks up where it stopped (finished days are skipped; --force re-imports them).
 *
 * Usage (from the repo root). Paste your DataFast website API key (df_..., from the site's
 * Settings -> API in DataFast) at the hidden prompt, so it never lands in shell history:
 *
 *   read -rs "DATAFAST_API_KEY?DataFast key: " && export DATAFAST_API_KEY
 *   node scripts/import-datafast.mjs --site <site id>
 *
 * Options:
 *   --site ID            Open Analytics site to import into (required)
 *   --from YYYY-MM-DD    first day (default: the first day DataFast has traffic)
 *   --to YYYY-MM-DD      last day (default and maximum: the day before Open Analytics data starts)
 *   --force              re-import days that were already imported
 *   --revenue-unit U     "major" (default: 29.99 means $29.99) or "minor" (2999 means $29.99)
 *   --datafast-site ID   DataFast website id, only needed with an account token (dft_...)
 *   --only a,b           re-import just these breakdowns (referrers, campaigns, pages, countries, regions,
 *                        cities, devices, browsers, operating-systems, goals); the rest stay as they are
 *   --probe              show what DataFast's pages/devices endpoints return for the busiest day, then stop
 *                        (they answer only when the day is sent as timestamps; the importer handles that)
 *   --local              write to the local dev database instead of the deployed one
 *   --dry-run            fetch and summarise, write nothing
 *   --api URL            DataFast API base (default https://datafa.st/api/v1)
 */
import { CONFIG } from './wrangler-config.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findKnownSource } from '../src/shared/sources.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'open-analytics';
const BATCH_DAYS = 7;
// DataFast allows 60 requests a minute per key. (Overridable only for testing against a mock server.)
const MIN_GAP_MS = Number(process.env.DATAFAST_MIN_GAP_MS) || 1050;

// ---------- arguments

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const siteId = opt('site');
const remote = !flag('local');
const dryRun = flag('dry-run');
const force = flag('force');
const revenueUnit = opt('revenue-unit') ?? 'major';
const apiBase = (opt('api') ?? 'https://datafa.st/api/v1').replace(/\/$/, '');
const key = process.env.DATAFAST_API_KEY?.trim();
const dfSite = opt('datafast-site');
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
if (!siteId || !/^[\w-]+$/.test(siteId)) fail('Pass the Open Analytics site id: --site <id> (Settings shows it in the script tag).');
if (!key) fail('Set DATAFAST_API_KEY first (see the comment at the top of this file).');
if (key.startsWith('dft_') && !dfSite) fail('An account token (dft_) also needs --datafast-site <DataFast website id>.');
if (!['major', 'minor'].includes(revenueUnit)) fail('--revenue-unit must be "major" or "minor".');
for (const o of ['from', 'to']) if (opt(o) && !isDay(opt(o))) fail(`--${o} must look like 2026-01-31.`);

// ---------- D1 (through wrangler, so it uses the same login and database as `npm run deploy`)

function wrangler(argv) {
  const r = spawnSync('npx', ['wrangler', ...argv], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`wrangler ${argv.slice(0, 3).join(' ')} failed:\n${(r.stderr || r.stdout).trim().slice(-2000)}`);
  return r.stdout;
}
function query(sql) {
  const out = wrangler(['d1', 'execute', DB, remote ? '--remote' : '--local', '-c', remote ? CONFIG : 'wrangler.jsonc', '--json', '--command', sql]);
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
function execFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-import-'));
  const file = join(dir, 'import.sql');
  writeFileSync(file, sql);
  try {
    wrangler(['d1', 'execute', DB, remote ? '--remote' : '--local', '-c', remote ? CONFIG : 'wrangler.jsonc', '--file', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(Math.round(v)) : `'${String(v).replace(/'/g, "''")}'`);

// ---------- dates in the site's timezone

const DAY = 86_400_000;
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
function dayIn(tz, ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
/** UTC ms of midnight starting `day` in `tz`. */
function midnight(day, tz) {
  const utc = Date.parse(day + 'T00:00:00Z');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(utc))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return utc - (asUtc - utc);
}

// ---------- DataFast API

let lastRequest = 0;
let requests = 0;
/** One API call. `soft`: a 4xx answer (a request shape DataFast doesn't accept) returns null instead of stopping. */
async function df(path, params = {}, { soft = false } = {}) {
  const url = new URL(apiBase + path);
  if (dfSite) url.searchParams.set('websiteId', dfSite);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequest + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    requests++;
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    } catch (e) {
      if (attempt >= 5) fail(`Could not reach DataFast (${e.message}).`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 6) fail(`DataFast kept answering ${res.status} for ${url.pathname}.`);
      const retryAfter = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const ms = retryAfter > 0 ? retryAfter * 1000 : reset > 1e9 ? Math.max(1000, reset * 1000 - Date.now()) : 15_000 * attempt;
      process.stdout.write(`  (DataFast ${res.status}, waiting ${Math.round(ms / 1000)}s)\n`);
      await new Promise((r) => setTimeout(r, Math.min(ms, 120_000)));
      continue;
    }
    const body = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) fail('DataFast rejected the API key (check it is the df_ key for this website).');
    if (soft && res.status >= 400 && res.status < 500) return null;
    if (!res.ok || !body || body.status === 'error') fail(`DataFast ${url.pathname} answered ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 300)}`);
    return body;
  }
}
/** A response's rows: `data` is usually the array itself, but some endpoints nest it one level down. */
function rowsOf(body) {
  const d = body?.data;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') return Object.values(d).find(Array.isArray) ?? [];
  return [];
}

/** Every row of a paginated endpoint. */
async function dfAll(path, params) {
  const rows = [];
  for (let offset = 0; ; ) {
    const body = await df(path, { ...params, limit: 1000, offset });
    const data = rowsOf(body);
    rows.push(...data);
    const total = body.pagination?.total;
    offset += data.length;
    if (!data.length || typeof total !== 'number' || offset >= total) return rows;
  }
}

/**
 * Some breakdowns (pages, devices) come back empty for a plain `startAt=endAt=<day>` query even on a day
 * with traffic, while the others answer it fine. So those try a few equivalent ways of asking for the
 * same day and keep the first that returns rows. Every variant covers exactly that one local day (the
 * timestamp variant uses the site's own UTC offset), so none can pull in a neighbouring day's numbers.
 */
const FIELDS = { '/analytics/pages': 'hostname,path,visitors,revenue,payments', '/analytics/devices': 'device,visitors,revenue,payments' };
const winning = new Map();
let sameTimezone = true; // set once DataFast's own timezone is known
function dayVariants(path, day, tz) {
  const fields = FIELDS[path];
  const from = new Date(midnight(day, tz)).toISOString();
  const to = new Date(midnight(addDays(day, 1), tz) - 1000).toISOString();
  return [
    { name: 'day', params: { startAt: day, endAt: day, timezone: tz } },
    { name: 'day + fields', params: { startAt: day, endAt: day, timezone: tz, fields } },
    { name: 'timestamps + fields', params: { startAt: from, endAt: to, timezone: tz, fields } },
    ...(sameTimezone ? [{ name: 'day, website timezone + fields', params: { startAt: day, endAt: day, fields } }] : []),
  ];
}
async function dfAllTry(path, day, tz) {
  const variants = dayVariants(path, day, tz);
  if (winning.has(path)) return dfAll(path, variants[winning.get(path)].params);
  for (const [i, v] of variants.entries()) {
    const rows = await dfAll(path, v.params);
    if (rows.length) {
      winning.set(path, i);
      return rows;
    }
  }
  return [];
}

// ---------- mapping DataFast's labels onto the dashboard's

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
let decimals = 2;
const money = (v) => (revenueUnit === 'major' ? Math.round(num(v) * 10 ** decimals) : Math.round(num(v)));

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
// Country names are compared loosely ("Trinidad and Tobago" = "Trinidad & Tobago", "Hong Kong" =
// "Hong Kong SAR China"), since DataFast and the browser's list spell many of them differently.
const looseName = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/\s+sar\s+china$/, '').replace(/[^a-z]/g, '');
const COUNTRY_CODES = new Map();
for (let a = 65; a <= 90; a++)
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    try {
      const name = regionNames.of(code);
      if (name && name !== code && !COUNTRY_CODES.has(looseName(name))) COUNTRY_CODES.set(looseName(name), code);
    } catch {}
  }
for (const [alias, code] of [
  ['united states of america', 'US'], ['usa', 'US'], ['uk', 'GB'], ['great britain', 'GB'], ['russian federation', 'RU'],
  ['south korea', 'KR'], ['republic of korea', 'KR'], ['czech republic', 'CZ'], ['turkey', 'TR'], ['türkiye', 'TR'],
  ['viet nam', 'VN'], ['vietnam', 'VN'], ['hong kong', 'HK'], ['macao', 'MO'], ['macau', 'MO'], ['ivory coast', 'CI'],
]) COUNTRY_CODES.set(looseName(alias), code);
// Codes some sources use that aren't ISO 3166 (and so have no flag): the UK as "UK", Greece as "EL".
const CODE_FIXES = { UK: 'GB', EL: 'GR' };
function countryCode(row) {
  // DataFast's `image` is the flag emoji: two regional-indicator letters spell the code.
  const flag = [...String(row.image ?? '')].map((c) => c.codePointAt(0) - 0x1f1e6);
  if (flag.length === 2 && flag.every((n) => n >= 0 && n < 26)) {
    const code = String.fromCharCode(65 + flag[0], 65 + flag[1]);
    return CODE_FIXES[code] ?? code;
  }
  const name = String(row.country ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(name)) return CODE_FIXES[name.toUpperCase()] ?? name.toUpperCase();
  return COUNTRY_CODES.get(looseName(name)) ?? (name || null);
}

/** DataFast's referrer ("Direct / None", "Google", "news.ycombinator.com", a URL) as Open Analytics source + channel. */
function source(referrer) {
  const raw = String(referrer ?? '').trim();
  if (!raw || /^direct\s*\/?\s*(none)?$/i.test(raw)) return { source: 'Direct/None', channel: 'Direct', domain: null };
  const host = raw.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
  const domain = /\.[a-z]{2,}$/.test(host) ? host.replace(/^www\./, '') : null;
  const known = findKnownSource(host) ?? findKnownSource(raw);
  if (known) return { source: known.name, channel: known.channel, domain: domain ?? known.domain };
  return { source: domain ?? raw, channel: 'Referral', domain };
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Each DataFast breakdown endpoint and the dashboard dimensions it fills. */
const ENDPOINT_DIMS = {
  referrers: ['source', 'channel'],
  campaigns: ['campaign', 'keyword', 'utm_source', 'utm_medium', 'utm_content', 'ref'],
  pages: ['page'],
  countries: ['country'],
  regions: ['region'],
  cities: ['city'],
  devices: ['device'],
  browsers: ['browser'],
  'operating-systems': ['os'],
  goals: ['goal'],
};
// --only pages,devices re-imports just those breakdowns for every day, leaving the rest as they are.
// `hourly` (the hourly totals behind hourly charts) is the one choice that isn't a breakdown.
const only = opt('only') ? opt('only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const ONLY_CHOICES = [...Object.keys(ENDPOINT_DIMS), 'hourly'];
if (only) for (const e of only) if (!ONLY_CHOICES.includes(e)) fail(`--only takes a comma-separated list of: ${ONLY_CHOICES.join(', ')}`);
const doHourly = !only || only.includes('hourly');
const onlyBreakdowns = only ? only.filter((e) => e !== 'hourly') : null;
const want = (endpoint) => !onlyBreakdowns || onlyBreakdowns.includes(endpoint);
const firstOf = (r, ...keys) => keys.map((k) => r[k]).find((v) => v !== undefined && v !== null && v !== '');

/** One day's breakdown rows, as { dim, label, extra, visitors, pageviews, revenue, customers }. */
async function breakdownsFor(day, tz) {
  const range = { startAt: day, endAt: day, timezone: tz };
  const out = new Map();
  const add = (dim, label, r, extra = null) => {
    const k = `${dim}\u0000${label ?? ''}`;
    const row = out.get(k) ?? { dim, label: label ?? '', extra, visitors: 0, pageviews: null, revenue: 0, customers: 0 };
    row.visitors += num(r.visitors);
    if (r.pageviews !== undefined && r.pageviews !== null) row.pageviews = (row.pageviews ?? 0) + num(r.pageviews);
    row.revenue += money(r.revenue);
    row.customers += num(r.payments);
    row.extra = row.extra ?? extra;
    out.set(k, row);
  };

  if (want('referrers'))
    for (const r of await dfAll('/analytics/referrers', range)) {
      const s = source(r.referrer);
      add('source', s.source, r, s.domain);
      add('channel', s.channel, r);
    }
  if (want('campaigns'))
    for (const r of await dfAll('/analytics/campaigns', range)) {
      const c = r.campaign ?? r;
      for (const [dim, field] of [['campaign', 'utm_campaign'], ['keyword', 'utm_term'], ['utm_source', 'utm_source'], ['utm_medium', 'utm_medium'], ['utm_content', 'utm_content'], ['ref', 'ref']]) {
        if (c[field]) add(dim, String(c[field]), r);
      }
    }
  if (want('pages'))
    for (const r of await dfAllTry('/analytics/pages', day, tz)) {
      // A path, or a full URL whose path is kept (Open Analytics stores paths without the host).
      let path = String(firstOf(r, 'path', 'page', 'pathname', 'url') ?? '/');
      if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
      add('page', path || '/', r);
    }
  if (want('countries')) for (const r of await dfAll('/analytics/countries', range)) add('country', countryCode(r), r);
  if (want('regions')) for (const r of await dfAll('/analytics/regions', range)) if (r.region) add('region', r.region, r);
  if (want('cities')) for (const r of await dfAll('/analytics/cities', range)) if (r.city) add('city', r.city, r);
  if (want('devices'))
    for (const r of await dfAllTry('/analytics/devices', day, tz)) add('device', cap(String(firstOf(r, 'device', 'type', 'name', 'device_type') ?? '')) || null, r);
  if (want('browsers')) for (const r of await dfAll('/analytics/browsers', range)) add('browser', r.browser || null, r);
  if (want('operating-systems')) for (const r of await dfAll('/analytics/operating-systems', range)) add('os', r.operating_system || null, r);
  if (want('goals'))
    for (const r of await dfAll('/analytics/goals', range)) {
      if (r.goal) add('goal', r.goal, { visitors: r.visitors, pageviews: r.completions });
    }
  return [...out.values()];
}

// ---------- run

const [site] = query(`SELECT id, name, timezone, currency, created_at FROM sites WHERE id = ${q(siteId)}`);
if (!site) fail(`No Open Analytics site with id ${siteId} in the ${remote ? 'deployed' : 'local'} database.`);
const tz = site.timezone;
decimals = new Intl.NumberFormat('en', { style: 'currency', currency: site.currency }).resolvedOptions().maximumFractionDigits ?? 2;

const [{ first }] = query(`SELECT MIN(started_at) AS first FROM sessions WHERE site_id = ${q(siteId)}`);
const today = dayIn(tz, Date.now());
const cutoff = first ? dayIn(tz, first) : today; // Open Analytics owns this day and everything after it
let to = addDays(cutoff, -1);
if (opt('to') && opt('to') < to) to = opt('to');

console.log(`\nImporting DataFast history into "${site.name}" (${siteId}), ${remote ? 'deployed' : 'LOCAL'} database`);
console.log(`Open Analytics data ${first ? `starts ${cutoff}` : 'has not started yet'}, so the import stops at ${to}.`);

const meta = (await df('/analytics/metadata')).data?.[0] ?? {};
if (meta.currency && meta.currency !== site.currency) {
  fail(`DataFast reports revenue in ${meta.currency} but this Open Analytics site uses ${site.currency}. Change the site's currency in Open Analytics settings first.`);
}
if (meta.timezone && meta.timezone !== tz) console.log(`Note: DataFast uses ${meta.timezone}; days are re-cut to the Open Analytics site's ${tz}.`);
// Asia/Calcutta and Asia/Kolkata are the same zone under two names; compare what they resolve to.
const canonical = (z) => new Intl.DateTimeFormat('en', { timeZone: z }).resolvedOptions().timeZone;
sameTimezone = !meta.timezone || canonical(meta.timezone) === canonical(tz);

const series = await dfAll('/analytics/timeseries', {
  interval: 'day',
  startAt: opt('from') ?? '2015-01-01',
  endAt: to,
  timezone: tz,
  fields: 'visitors,sessions,pageviews,revenue,payments',
});
const days = new Map();
for (const r of series) {
  const day = isDay(String(r.timestamp).slice(0, 10)) && !String(r.timestamp).includes('T') ? String(r.timestamp) : dayIn(tz, Date.parse(r.timestamp));
  if (day > to || (opt('from') && day < opt('from'))) continue;
  days.set(day, { visitors: num(r.visitors), sessions: num(r.sessions), pageviews: num(r.pageviews), revenue: money(r.revenue), payments: num(r.payments) });
}
const active = [...days].filter(([, d]) => d.visitors || d.pageviews || d.revenue).map(([day]) => day).sort();
if (!active.length) fail('DataFast returned no traffic for that period.');
const from = opt('from') ?? active[0];
const wanted = [...days.keys()].filter((d) => d >= from && d <= to).sort();

// --probe: show the raw shape of each breakdown response for the busiest day, then stop. For checking
// what DataFast actually returns against what its docs describe. Prints data only, never the key.
if (flag('probe')) {
  const busiest = active.reduce((a, d) => (days.get(d).visitors > days.get(a).visitors ? d : a), active[0]);
  console.log(`\nProbing DataFast's pages and devices for ${busiest} (${days.get(busiest).visitors} visitors that day):\n`);
  let found = 0;
  for (const path of ['/analytics/pages', '/analytics/devices']) {
    for (const v of dayVariants(path, busiest, tz)) {
      const body = await df(path, { ...v.params, limit: 3 });
      const rows = rowsOf(body);
      console.log(`${path.padEnd(20)} ${v.name.padEnd(32)} total ${String(body.pagination?.total ?? rows.length).padStart(5)}  ${JSON.stringify(rows[0] ?? null).slice(0, 160)}`);
      if (rows.length) {
        found++;
        break;
      }
    }
  }
  if (found < 2) {
    console.log(`\n✗ DataFast returned no ${found ? 'devices' : 'pages or devices'} for that day however it was asked. Nothing to re-import.\n`);
    process.exit(3);
  }
  console.log('\n✓ Found a way to fetch both. Re-importing pages and devices next.\n');
  process.exit(0);
}

const done = force || dryRun || only ? new Set() : new Set(query(`SELECT day FROM imported_daily WHERE site_id = ${q(siteId)}`).map((r) => r.day));
if (only) console.log(`Re-importing only: ${only.join(', ')} (other breakdowns are left as they are).`);
const todo = wanted.filter((d) => !done.has(d));
const totals = wanted.reduce((t, d) => ({ visitors: t.visitors + days.get(d).visitors, revenue: t.revenue + days.get(d).revenue }), { visitors: 0, revenue: 0 });
const fmt = (minor) => new Intl.NumberFormat('en', { style: 'currency', currency: site.currency }).format(minor / 10 ** decimals);

console.log(`DataFast has ${wanted.length} days from ${from} to ${to}: ${totals.visitors.toLocaleString()} visitor-days, ${fmt(totals.revenue)} revenue.`);
console.log(`→ Check that revenue against DataFast. If it is 100× off, re-run with --revenue-unit ${revenueUnit === 'major' ? 'minor' : 'major'} --force.`);
if (done.size) console.log(`${wanted.length - todo.length} of those days were imported before and are skipped (--force re-imports them).`);

/** The site-local hour a timestamp falls in, labelled like the dashboard's hourly buckets. */
function hourIn(zone, ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}

/**
 * Hourly totals for the whole range, for hourly charts. Asked for a week at a time; if DataFast won't
 * give hourly buckets for a week (it answers with a different interval, or refuses), each day is asked
 * for on its own. Cheap either way: a handful of requests, or one per day.
 */
async function importHourly() {
  const fields = 'visitors,pageviews,revenue,payments';
  const hours = new Map();
  const take = (rows) => {
    for (const r of rows) {
      const ts = String(r.timestamp);
      const hour = hourIn(tz, Date.parse(ts.includes('T') ? ts : `${ts}T00:00:00`));
      if (hour < `${from}T00:00` || hour > `${to}T23:00`) continue;
      const h = hours.get(hour) ?? { visitors: 0, pageviews: 0, revenue: 0, payments: 0 };
      h.visitors += num(r.visitors);
      h.pageviews += num(r.pageviews);
      h.revenue += money(r.revenue);
      h.payments += num(r.payments);
      hours.set(hour, h);
    }
  };
  let weekly = true;
  for (let start = from; start <= to; start = addDays(start, 7)) {
    const end = addDays(start, 6) < to ? addDays(start, 6) : to;
    if (weekly) {
      const body = await df('/analytics/timeseries', { interval: 'hour', startAt: start, endAt: end, timezone: tz, fields, limit: 1000 }, { soft: true });
      if (body && (body.interval ?? 'hour') === 'hour' && rowsOf(body).length > 7) {
        take(rowsOf(body));
        continue;
      }
      weekly = false; // fall through to one day at a time from here on
    }
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const body = await df('/analytics/timeseries', { interval: 'hour', startAt: day, endAt: day, timezone: tz, fields, limit: 100 }, { soft: true });
      if (body) take(rowsOf(body));
    }
  }
  const rows = [...hours].filter(([, h]) => h.visitors || h.pageviews || h.revenue || h.payments);
  console.log(`Hourly totals: ${rows.length} hours with traffic, ${weekly ? 'fetched a week at a time' : 'fetched day by day'}.`);
  if (dryRun) return;
  const sql = [`DELETE FROM imported_hourly WHERE site_id = ${q(siteId)} AND hour >= ${q(`${from}T00:00`)} AND hour <= ${q(`${to}T23:00`)};`];
  for (const [hour, h] of rows) {
    sql.push(
      `INSERT OR REPLACE INTO imported_hourly (site_id, hour, visitors, pageviews, revenue, payments) VALUES (${[siteId, hour, h.visitors, h.pageviews, h.revenue, h.payments].map(q).join(', ')});`,
    );
  }
  execFile(sql.join('\n'));
}

if (doHourly) await importHourly();
if (onlyBreakdowns && !onlyBreakdowns.length) {
  console.log(`\n✓ Done (${requests} DataFast requests).\n`);
  process.exit(0);
}
if (!todo.length) {
  console.log('\nNothing left to import.\n');
  process.exit(0);
}
const minutes = Math.ceil((todo.length * (onlyBreakdowns ? onlyBreakdowns.length : 10) * MIN_GAP_MS) / 60_000);
console.log(`Fetching breakdowns for ${todo.length} days (about ${minutes} min at DataFast's rate limit)...\n`);

let batch = [];
let imported = 0;
function flush() {
  if (!batch.length || dryRun) return (batch = []);
  const sql = [];
  const dims = onlyBreakdowns ? onlyBreakdowns.flatMap((e) => ENDPOINT_DIMS[e]) : null;
  for (const { day, total, rows } of batch) {
    sql.push(`DELETE FROM imported_breakdown WHERE site_id = ${q(siteId)} AND day = ${q(day)}${dims ? ` AND dim IN (${dims.map(q).join(', ')})` : ''};`);
    for (const r of rows) {
      sql.push(
        `INSERT OR REPLACE INTO imported_breakdown (site_id, dim, day, label, extra, visitors, pageviews, revenue, customers) VALUES (${[siteId, r.dim, day, r.label, r.extra, r.visitors, r.pageviews, r.revenue, r.customers].map(q).join(', ')});`,
      );
    }
    // The day row goes last: its presence is what marks the day as finished.
    sql.push(
      `INSERT OR REPLACE INTO imported_daily (site_id, day, visitors, sessions, pageviews, revenue, payments, origin) VALUES (${[siteId, day, total.visitors, total.sessions, total.pageviews, total.revenue, total.payments, 'datafast'].map(q).join(', ')});`,
    );
  }
  execFile(sql.join('\n'));
  imported += batch.length;
  batch = [];
}

for (const [i, day] of todo.entries()) {
  const rows = await breakdownsFor(day, tz);
  batch.push({ day, total: days.get(day), rows });
  process.stdout.write(`  ${day}  ${String(days.get(day).visitors).padStart(6)} visitors  ${String(rows.length).padStart(4)} rows   (${i + 1}/${todo.length})\n`);
  if (batch.length >= BATCH_DAYS) flush();
}
flush();

if (!dryRun) {
  // "All time" starts at the site's creation date; reach back to the first imported day.
  execFile(`UPDATE sites SET created_at = MIN(created_at, ${midnight(from, tz)}) WHERE id = ${q(siteId)};`);
}
console.log(`\n✓ ${dryRun ? 'Dry run: fetched' : 'Imported'} ${dryRun ? todo.length : imported} days (${requests} DataFast requests).${dryRun ? ' Nothing was written.' : ' Open the dashboard and pick "All time".'}\n`);
