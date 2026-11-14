import type { Context } from 'hono';
import type { AppEnv, Site } from './env';
import { bucketLabels, bucketSql, resolveRange, tzOffset, type Range } from './lib/time';
import { currencyDecimals } from './payments';

/** Filters that live on the session row (clicking a row in the dashboard adds one of these). */
const SESSION_FILTERS = [
  'channel',
  'source',
  'referrer_domain',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device',
  'entry_page',
  'exit_page',
  'hostname',
] as const;

export type Filters = Partial<Record<(typeof SESSION_FILTERS)[number] | 'page' | 'goal', string>>;

export function parseFilters(raw: string | undefined): Filters {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    const out: Filters = {};
    for (const k of [...SESSION_FILTERS, 'page', 'goal'] as const) {
      if (typeof obj[k] === 'string') out[k] = obj[k].slice(0, 500);
    }
    return out;
  } catch {
    return {};
  }
}

/** SQL + params restricting sessions `s` by the dashboard filters (not by time). */
function filterSql(f: Filters): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const k of SESSION_FILTERS) {
    const v = f[k];
    if (v === undefined) continue;
    if (v === '') parts.push(`s.${k} IS NULL`);
    else {
      parts.push(`s.${k} = ?`);
      params.push(v);
    }
  }
  if (f.page) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'pageview' AND fe.path = ?)`);
    params.push(f.page);
  }
  if (f.goal) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'goal' AND fe.name = ?)`);
    params.push(f.goal);
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

const hasFilters = (f: Filters) => Object.keys(f).length > 0;

interface Ctx {
  db: D1Database;
  site: Site;
  range: Range;
  filters: Filters;
  offset: number;
}

export function makeCtx(c: Context<AppEnv>): Ctx {
  const site = c.get('site');
  const q = c.req.query();
  const range = resolveRange(q, site.timezone, site.created_at);
  return { db: c.env.DB, site, range, filters: parseFilters(q.filters), offset: tzOffset(site.timezone, range.to) };
}

function sessionsWhere(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  const f = filterSql(ctx.filters);
  return {
    sql: `s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

/** Payments in the period; with filters, only those credited to a matching visit. */
function paymentsFrom(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  if (!hasFilters(ctx.filters)) {
    return { sql: `payments p WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?`, params: [ctx.site.id, from, to] };
  }
  const f = filterSql(ctx.filters);
  return {
    sql: `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
          WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

const KPI_SQL = (where: string) => `
  SELECT COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, COALESCE(SUM(s.pageviews), 0) AS pageviews,
         COALESCE(SUM(CASE WHEN s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END), 0) AS bounces,
         COALESCE(AVG(s.duration), 0) AS avg_duration
  FROM sessions s WHERE ${where}`;

const REVENUE_SQL = (from: string) => `
  SELECT COALESCE(SUM(p.amount), 0) AS revenue,
         COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.id) END) AS customers,
         COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END), 0) AS payments
  FROM ${from}`;

interface KpiRow {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  avg_duration: number;
}
interface RevRow {
  revenue: number;
  customers: number;
  payments: number;
}
interface ImportedRow {
  visitors: number;
  sessions: number;
  pageviews: number;
  revenue: number;
  payments: number;
}

// ---------- imported history (DataFast), stored as whole days in imported_daily / imported_breakdown

/** Bound to a day range no row can match, so a query that must not see imported data returns nothing. */
const NO_DAYS = { from: '9999-12-31', to: '0000-01-01' };

/**
 * The days (site time, inclusive) a range covers in the imported tables. Imported days are
 * totals with no per-visit detail, so they can't be filtered: with any filter set they're left out.
 */
function importedDays(ctx: Ctx, from = ctx.range.from, to = ctx.range.to): { from: string; to: string } {
  if (hasFilters(ctx.filters)) return NO_DAYS;
  const day = (t: number) => new Date(t + ctx.offset).toISOString().slice(0, 10);
  // A whole imported day counts only if the range covers its middle (local noon). Otherwise a short
  // range that clips a day, like the 2 hours before midnight that "today" is compared with at 2 AM,
  // would pick up that entire day's totals.
  const HALF_DAY = 43_200_000;
  return { from: day(from + HALF_DAY), to: day(to - HALF_DAY - 1) };
}

const IMPORTED_SQL = `
  SELECT COALESCE(SUM(visitors), 0) AS visitors, COALESCE(SUM(sessions), 0) AS sessions, COALESCE(SUM(pageviews), 0) AS pageviews,
         COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(payments), 0) AS payments
  FROM imported_daily WHERE site_id = ? AND day >= ? AND day <= ?`;

/**
 * Imported numbers add to the totals. Visitors are summed per day (DataFast only gives daily
 * uniques), so a visitor seen on several imported days counts once per day. Bounce rate and
 * session time aren't in the import and stay Open Analytics-only.
 */
function kpis(k: KpiRow, r: RevRow, imp?: ImportedRow) {
  const visitors = k.visitors + (imp?.visitors ?? 0);
  const revenue = r.revenue + (imp?.revenue ?? 0);
  const customers = r.customers + (imp?.payments ?? 0);
  return {
    visitors,
    sessions: k.sessions + (imp?.sessions ?? 0),
    pageviews: k.pageviews + (imp?.pageviews ?? 0),
    bounceRate: k.sessions ? k.bounces / k.sessions : 0,
    avgDuration: Math.round(k.avg_duration),
    revenue,
    payments: r.payments + (imp?.payments ?? 0),
    customers,
    conversionRate: visitors ? customers / visitors : 0,
    revenuePerVisitor: visitors ? revenue / visitors : 0,
  };
}

/** Add imported rows for `dim` to a breakdown, matching on label. */
async function withImported(ctx: Ctx, dim: string, rows: BreakdownRow[], lim: number): Promise<BreakdownRow[]> {
  const d = importedDays(ctx);
  if (d === NO_DAYS) return rows;
  const imported = await ctx.db
    .prepare(
      `SELECT NULLIF(label, '') AS label, SUM(visitors) AS visitors, SUM(pageviews) AS pageviews, SUM(revenue) AS revenue,
              SUM(customers) AS customers, MAX(extra) AS extra
       FROM imported_breakdown WHERE site_id = ? AND dim = ? AND day >= ? AND day <= ?
       GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
    )
    .bind(ctx.site.id, dim, d.from, d.to)
    .all<{ label: string | null; visitors: number; pageviews: number | null; revenue: number; customers: number; extra: string | null }>();
  if (!imported.results.length) return rows;
  const byLabel = new Map(rows.map((r) => [r.label, { ...r }]));
  for (const i of imported.results) {
    const row = byLabel.get(i.label);
    if (row) {
      row.visitors += i.visitors;
      if (i.pageviews !== null) row.pageviews = (row.pageviews ?? 0) + i.pageviews;
      row.revenue += i.revenue;
      row.customers += i.customers;
      row.extra = row.extra ?? i.extra;
    } else {
      byLabel.set(i.label, { label: i.label, visitors: i.visitors, pageviews: i.pageviews ?? undefined, revenue: i.revenue, customers: i.customers, extra: i.extra });
    }
  }
  return [...byLabel.values()].sort((a, b) => b.visitors - a.visitors || b.revenue - a.revenue).slice(0, lim);
}

/** Top numbers + chart. */
export async function overview(ctx: Ctx) {
  const { db, range, site } = ctx;
  const prevFrom = range.from - (range.to - range.from);
  const cur = sessionsWhere(ctx);
  const prev = sessionsWhere(ctx, prevFrom, range.from);
  const curPay = paymentsFrom(ctx);
  const prevPay = paymentsFrom(ctx, prevFrom, range.from);
  const sb = bucketSql('s.started_at', range.granularity, ctx.offset);
  const pb = bucketSql('p.ts', range.granularity, ctx.offset);
  const now = Date.now();
  const curDays = importedDays(ctx);
  const prevDays = importedDays(ctx, prevFrom, range.from);
  // The chart's imported part: hourly charts read the imported hours (labelled like the chart's own
  // buckets), longer ones roll the imported days up into days, weeks or months.
  const hourly = range.granularity === 'hour';
  const hourOf = (t: number) => new Date(t + ctx.offset).toISOString().slice(0, 13) + ':00';
  const seriesSpan = hasFilters(ctx.filters) ? NO_DAYS : hourly ? { from: hourOf(range.from), to: hourOf(range.to - 1) } : curDays;
  const ib = range.granularity === 'week' ? `date(day, 'weekday 0', '-6 days')` : range.granularity === 'month' ? 'substr(day, 1, 7)' : 'day';
  const importedSeriesSql = hourly
    ? `SELECT hour AS b, visitors, pageviews, revenue, payments FROM imported_hourly WHERE site_id = ? AND hour >= ? AND hour <= ?`
    : `SELECT ${ib} AS b, SUM(visitors) AS visitors, SUM(pageviews) AS pageviews, SUM(revenue) AS revenue, SUM(payments) AS payments
       FROM imported_daily WHERE site_id = ? AND day >= ? AND day <= ? GROUP BY b`;

  const [k1, k0, r1, r0, online, ts, tr, i1, i0, is, icover] = await db.batch([
    db.prepare(KPI_SQL(cur.sql)).bind(...cur.params),
    db.prepare(KPI_SQL(prev.sql)).bind(...prev.params),
    db.prepare(REVENUE_SQL(curPay.sql)).bind(...curPay.params),
    db.prepare(REVENUE_SQL(prevPay.sql)).bind(...prevPay.params),
    db
      .prepare(`SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE site_id = ? AND ts > ? AND type IN ${ONLINE_EVENTS}`)
      .bind(site.id, now - ONLINE_MS),
    db
      .prepare(
        `SELECT ${sb} AS b, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews
         FROM sessions s WHERE ${cur.sql} GROUP BY b`,
      )
      .bind(...cur.params),
    db
      .prepare(
        `SELECT ${pb} AS b, SUM(p.amount) AS revenue, SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END) AS payments
         FROM ${curPay.sql} GROUP BY b`,
      )
      .bind(...curPay.params),
    db.prepare(IMPORTED_SQL).bind(site.id, curDays.from, curDays.to),
    db.prepare(IMPORTED_SQL).bind(site.id, prevDays.from, prevDays.to),
    db.prepare(importedSeriesSql).bind(site.id, seriesSpan.from, seriesSpan.to),
    db.prepare('SELECT MIN(day) AS first, MAX(day) AS last, MAX(origin) AS origin FROM imported_daily WHERE site_id = ?').bind(site.id),
  ]);

  const visitorsBy = new Map((ts.results as any[]).map((r) => [r.b, r]));
  const revenueBy = new Map((tr.results as any[]).map((r) => [r.b, r]));
  const importedBy = new Map((is.results as any[]).map((r) => [r.b, r]));
  const labels = bucketLabels(range, ctx.offset);
  const series = labels.map((b) => ({
    bucket: b,
    visitors: (visitorsBy.get(b)?.visitors ?? 0) + (importedBy.get(b)?.visitors ?? 0),
    pageviews: (visitorsBy.get(b)?.pageviews ?? 0) + (importedBy.get(b)?.pageviews ?? 0),
    revenue: (revenueBy.get(b)?.revenue ?? 0) + (importedBy.get(b)?.revenue ?? 0),
    payments: (revenueBy.get(b)?.payments ?? 0) + (importedBy.get(b)?.payments ?? 0),
  }));
  const cover = icover.results[0] as { first: string | null; last: string | null; origin: string | null } | undefined;

  return {
    range,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
    current: kpis(k1.results[0] as KpiRow, r1.results[0] as RevRow, i1.results[0] as ImportedRow),
    previous: kpis(k0.results[0] as KpiRow, r0.results[0] as RevRow, i0.results[0] as ImportedRow),
    online: (online.results[0] as { n: number }).n,
    series,
    /** Days of history imported from another tool, if any (whether or not this range includes them). */
    imported: cover?.first ? { from: cover.first, to: cover.last!, origin: cover.origin ?? 'datafast' } : null,
  };
}

/** Session dimensions, keyed by the name the dashboard asks for. */
const SESSION_DIMS: Record<string, string> = {
  channel: 's.channel',
  source: 's.source',
  campaign: 's.utm_campaign',
  keyword: 's.utm_term',
  utm_source: 's.utm_source',
  utm_medium: 's.utm_medium',
  utm_content: 's.utm_content',
  ref: 's.ref',
  country: 's.country',
  region: 's.region',
  city: 's.city',
  browser: 's.browser',
  os: 's.os',
  device: 's.device',
  entry_page: 's.entry_page',
  exit_page: 's.exit_page',
  hostname: 's.hostname',
  referrer: 's.referrer',
};

export interface BreakdownRow {
  label: string | null;
  visitors: number;
  pageviews?: number;
  revenue: number;
  customers: number;
  icon?: string | null;
  extra?: string | null;
}

export async function breakdown(ctx: Ctx, dim: string, limit = 100): Promise<BreakdownRow[]> {
  const { db } = ctx;
  const lim = Math.max(1, Math.min(500, limit));

  if (SESSION_DIMS[dim]) {
    const col = SESSION_DIMS[dim];
    const w = sessionsWhere(ctx);
    const pay = paymentsFrom(ctx);
    // Payments need the session columns even without filters.
    const payJoin = hasFilters(ctx.filters)
      ? pay
      : {
          sql: `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?`,
          params: pay.params,
        };
    const extraCol =
      dim === 'source' ? 'MAX(s.referrer_domain)' : dim === 'region' || dim === 'city' ? 'MAX(s.country)' : 'NULL';
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT ${col} AS label, COUNT(DISTINCT s.visitor_id) AS visitors, SUM(s.pageviews) AS pageviews, ${extraCol} AS extra
           FROM sessions s WHERE ${w.sql} GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...w.params),
      db
        .prepare(
          `SELECT ${col} AS label, SUM(p.amount) AS revenue,
                  COUNT(DISTINCT CASE WHEN p.kind = 'payment' THEN COALESCE(p.visitor_id, p.id) END) AS customers
           FROM ${payJoin.sql} GROUP BY label`,
        )
        .bind(...payJoin.params),
    ]);
    return withImported(ctx, dim, merge(v.results as any[], r.results as any[]), lim);
  }

  if (dim === 'page') {
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${f.sql}`;
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT e.path AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
           GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...params),
      // Revenue from customers who viewed the page during the period.
      db
        .prepare(
          `SELECT pv.label, SUM(p.amount) AS revenue, COUNT(DISTINCT p.visitor_id) AS customers
           FROM (SELECT DISTINCT e.path AS label, e.visitor_id ${base}) pv
           JOIN payments p ON p.site_id = ? AND p.visitor_id = pv.visitor_id AND p.ts >= ? AND p.ts < ?
           GROUP BY pv.label`,
        )
        .bind(...params, ctx.site.id, ctx.range.from, ctx.range.to),
    ]);
    return withImported(ctx, dim, merge(v.results as any[], r.results as any[]), lim);
  }

  if (dim === 'exit_link' || dim === 'goal') {
    const type = dim === 'goal' ? 'goal' : 'outbound';
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, type, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = ? AND e.ts >= ? AND e.ts < ?${f.sql}`;
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT e.name AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
           GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...params),
      db
        .prepare(
          `SELECT g.label, SUM(p.amount) AS revenue, COUNT(DISTINCT p.visitor_id) AS customers
           FROM (SELECT DISTINCT e.name AS label, e.visitor_id ${base}) g
           JOIN payments p ON p.site_id = ? AND p.visitor_id = g.visitor_id AND p.ts >= ? AND p.ts < ?
           GROUP BY g.label`,
        )
        .bind(...params, ctx.site.id, ctx.range.from, ctx.range.to),
    ]);
    return withImported(ctx, dim, merge(v.results as any[], r.results as any[]), lim);
  }

  throw new Error(`unknown dimension ${dim}`);
}

function merge(visits: any[], revenue: any[]): BreakdownRow[] {
  const rev = new Map(revenue.map((r) => [r.label, r]));
  const rows: BreakdownRow[] = visits.map((v) => ({
    label: v.label,
    visitors: v.visitors,
    pageviews: v.pageviews ?? undefined,
    revenue: rev.get(v.label)?.revenue ?? 0,
    customers: rev.get(v.label)?.customers ?? 0,
    extra: v.extra ?? null,
  }));
  // Sources that made money but had no visits in this period (paid later) still show up.
  const seen = new Set(visits.map((v) => v.label));
  for (const r of revenue) if (!seen.has(r.label)) rows.push({ label: r.label, visitors: 0, revenue: r.revenue, customers: r.customers });
  return rows;
}

/** Customers in the period, with where they came from (the "Journey" tab). */
export async function customers(ctx: Ctx) {
  const { db, site, range } = ctx;
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN' : 'LEFT JOIN';
  const res = await db
    .prepare(
      `SELECT p.id, p.ts, p.amount, p.currency, p.renewal, p.matched_by, p.email AS pay_email, p.name AS pay_name, p.visitor_id, p.session_id,
              v.first_seen, v.name, v.email, v.user_id,
              s.source, s.channel, s.referrer_domain, s.utm_campaign, s.ref, s.country, s.city, s.device, s.os, s.browser, s.entry_page,
              (SELECT COUNT(*) FROM sessions s2 WHERE s2.site_id = p.site_id AND s2.visitor_id = p.visitor_id AND s2.started_at <= p.ts) AS visits
       FROM payments p
       LEFT JOIN visitors v ON v.site_id = p.site_id AND v.id = p.visitor_id
       ${join} sessions s ON s.site_id = p.site_id AND s.id = p.session_id
       WHERE p.site_id = ? AND p.kind = 'payment' AND p.ts >= ? AND p.ts < ?${f.sql}
       ORDER BY p.ts DESC LIMIT 200`,
    )
    .bind(site.id, range.from, range.to, ...f.params)
    .all();
  return res.results;
}

/** Recent visitors in the period (the "Users" tab). */
export async function visitors(ctx: Ctx) {
  const w = sessionsWhere(ctx);
  const res = await ctx.db
    .prepare(
      `SELECT t.*, v.name, v.email, v.user_id, v.first_seen,
              (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = t.site_id AND p.visitor_id = t.visitor_id) AS spent
       FROM (
         SELECT s.site_id, s.visitor_id, MAX(s.last_seen_at) AS last_seen, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews,
                SUM(s.duration) AS duration, s.source, s.referrer_domain, s.country, s.city, s.device, s.os, s.browser
         FROM sessions s WHERE ${w.sql} GROUP BY s.visitor_id ORDER BY last_seen DESC LIMIT 200
       ) t LEFT JOIN visitors v ON v.site_id = t.site_id AND v.id = t.visitor_id
       ORDER BY t.last_seen DESC`,
    )
    .bind(...w.params)
    .all();
  return res.results;
}

/** Everything one visitor did: visits, pages, clicks, payments. */
export async function visitorProfile(db: D1Database, site: Site, vid: string) {
  const [v, s, e, p] = await db.batch([
    db.prepare('SELECT * FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid),
    db.prepare('SELECT * FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 100').bind(site.id, vid),
    db
      .prepare('SELECT session_id, ts, type, name, path, props FROM events WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC LIMIT 1000')
      .bind(site.id, vid),
    db.prepare('SELECT * FROM payments WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC').bind(site.id, vid),
  ]);
  return {
    visitor: v.results[0] ?? null,
    sessions: s.results,
    events: e.results,
    payments: p.results,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
  };
}

export interface FunnelStep {
  type: 'page' | 'goal';
  value: string; // page paths support * wildcards, e.g. /blog/*
  label?: string;
}

/** Visitors who completed each step, in order, within the period. */
export async function funnel(ctx: Ctx, steps: FunnelStep[]) {
  if (!steps.length) return [];
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
  const conds: string[] = [];
  const params: unknown[] = [];
  for (const st of steps) {
    if (st.type === 'goal') {
      conds.push(`(e.type = 'goal' AND e.name = ?)`);
      params.push(st.value);
    } else {
      conds.push(`(e.type = 'pageview' AND e.path GLOB ?)`);
      params.push(st.value);
    }
  }
  const rows = (
    await ctx.db
      .prepare(
        `SELECT e.visitor_id AS v, e.ts, e.type, e.name, e.path FROM events e ${join}
         WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND (${conds.join(' OR ')})${f.sql}
         ORDER BY e.ts LIMIT 100000`,
      )
      .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...params, ...f.params)
      .all<{ v: string; ts: number; type: string; name: string | null; path: string }>()
  ).results;

  const matchers = steps.map((st) => {
    if (st.type === 'goal') return (r: (typeof rows)[0]) => r.type === 'goal' && r.name === st.value;
    const re = new RegExp('^' + st.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return (r: (typeof rows)[0]) => r.type === 'pageview' && re.test(r.path);
  });
  const progress = new Map<string, number>();
  for (const r of rows) {
    const at = progress.get(r.v) ?? 0;
    if (at < steps.length && matchers[at](r)) progress.set(r.v, at + 1);
  }
  const counts = steps.map(() => 0);
  for (const reached of progress.values()) for (let i = 0; i < reached; i++) counts[i]++;
  return steps.map((st, i) => ({ ...st, visitors: counts[i] }));
}

/**
 * Who counts as "online": someone who opened a page or completed a goal in the last 10 minutes (the same
 * rule DataFast uses). Deliberately not `last_seen_at`: the tracker's engaged-time pings keep that fresh
 * for up to 30 minutes while a tab merely sits open, which would show idle people as live.
 */
export const ONLINE_MS = 10 * 60_000;
export const ONLINE_EVENTS = "('pageview', 'goal')";

/** Everything the live map needs: who is active right now, and what they did in the same window. */
export async function realtime(db: D1Database, site: Site, now = Date.now()) {
  const ACTIVE_MS = ONLINE_MS;
  const FEED_MS = ONLINE_MS;
  const [visitors, events, payments] = await db.batch([
    db
      .prepare(
        `SELECT s.visitor_id, s.id AS session_id, s.lat, s.lon, s.country, s.region, s.city, s.device, s.browser, s.os,
                s.source, s.referrer_domain, s.exit_page AS page, s.started_at, s.last_seen_at, s.pageviews,
                a.last_active AS last_active_at, v.name, v.email,
                (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.site_id = s.site_id AND p.visitor_id = s.visitor_id) AS spent
         FROM (SELECT session_id, MAX(ts) AS last_active FROM events
               WHERE site_id = ? AND ts > ? AND type IN ${ONLINE_EVENTS} GROUP BY session_id) a
         JOIN sessions s ON s.site_id = ? AND s.id = a.session_id
         LEFT JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         ORDER BY a.last_active DESC LIMIT 500`,
      )
      .bind(site.id, now - ACTIVE_MS, site.id),
    db
      .prepare(
        `SELECT e.id, e.ts, e.type, e.name, e.path, e.visitor_id, s.country, s.lat, s.lon, v.name AS vname, v.email AS vemail
         FROM events e
         LEFT JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id
         LEFT JOIN visitors v ON v.site_id = e.site_id AND v.id = e.visitor_id
         WHERE e.site_id = ? AND e.ts > ? AND e.type IN ('pageview', 'goal')
         ORDER BY e.ts DESC LIMIT 100`,
      )
      .bind(site.id, now - FEED_MS),
    db
      .prepare(
        `SELECT p.id, p.ts, p.amount, p.kind, p.visitor_id, p.name, p.email, s.country, s.lat, s.lon
         FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE p.site_id = ? AND p.ts > ?
         ORDER BY p.ts DESC LIMIT 50`,
      )
      .bind(site.id, now - FEED_MS),
  ]);

  // One marker per visitor (their most recent visit).
  const seen = new Set<string>();
  const active = (visitors.results as any[]).filter((v) => !seen.has(v.visitor_id) && seen.add(v.visitor_id));

  const feed = [
    ...(events.results as any[]).map((e) => ({
      id: `e${e.id}`,
      ts: e.ts,
      type: e.type as 'pageview' | 'goal',
      label: e.type === 'goal' ? e.name : e.path,
      visitor_id: e.visitor_id,
      name: e.vname ?? e.vemail ?? null,
      country: e.country,
      lat: e.lat,
      lon: e.lon,
    })),
    ...(payments.results as any[]).map((p) => ({
      id: `p${p.id}`,
      ts: p.ts,
      type: (p.kind === 'refund' ? 'refund' : 'payment') as 'payment' | 'refund',
      amount: p.amount,
      visitor_id: p.visitor_id,
      name: p.name ?? p.email ?? null,
      country: p.country,
      lat: p.lat,
      lon: p.lon,
    })),
  ].sort((a, b) => b.ts - a.ts);

  return { now, currency: site.currency, decimals: currencyDecimals(site.currency), domain: site.domain, visitors: active, feed };
}

/** Sparkline sizes for the all-websites view: [range, bucket count]. Rolling windows, so no timezone maths. */
const SPARK_PERIODS: Record<string, [number, number]> = {
  '24h': [86_400_000, 24],
  '7d': [7 * 86_400_000, 28],
  '30d': [30 * 86_400_000, 30],
  '90d': [90 * 86_400_000, 45],
};

export interface SiteSpark {
  id: string;
  visitors: number;
  revenue: number;
  online: number;
  series: { visitors: number; revenue: number }[];
}

/** Totals and a small visitors/revenue series for every site the user can see, in one round trip. */
export async function sparklines(db: D1Database, siteIds: string[], period: string, now = Date.now()): Promise<SiteSpark[]> {
  if (!siteIds.length) return [];
  // D1 allows 100 bound parameters per statement.
  if (siteIds.length > 90) {
    const chunks = [];
    for (let i = 0; i < siteIds.length; i += 90) chunks.push(sparklines(db, siteIds.slice(i, i + 90), period, now));
    return (await Promise.all(chunks)).flat();
  }
  const [span, n] = SPARK_PERIODS[period] ?? SPARK_PERIODS['30d'];
  const width = span / n;
  const from = now - span;
  const ids = siteIds.map(() => '?').join(', ');
  const bucket = (col: string) => `MIN(${n - 1}, CAST((${col} - ${from}) / ${width} AS INTEGER))`;

  const [totals, pay, online, vs, rs, imported] = await db.batch([
    db
      .prepare(`SELECT site_id, COUNT(DISTINCT visitor_id) AS v FROM sessions WHERE site_id IN (${ids}) AND started_at >= ? GROUP BY site_id`)
      .bind(...siteIds, from),
    db.prepare(`SELECT site_id, SUM(amount) AS r FROM payments WHERE site_id IN (${ids}) AND ts >= ? GROUP BY site_id`).bind(...siteIds, from),
    db
      .prepare(
        `SELECT site_id, COUNT(DISTINCT visitor_id) AS n FROM events
         WHERE site_id IN (${ids}) AND ts > ? AND type IN ${ONLINE_EVENTS} GROUP BY site_id`,
      )
      .bind(...siteIds, now - ONLINE_MS),
    db
      .prepare(
        `SELECT site_id, ${bucket('started_at')} AS b, COUNT(DISTINCT visitor_id) AS v FROM sessions
         WHERE site_id IN (${ids}) AND started_at >= ? GROUP BY site_id, b`,
      )
      .bind(...siteIds, from),
    db
      .prepare(`SELECT site_id, ${bucket('ts')} AS b, SUM(amount) AS r FROM payments WHERE site_id IN (${ids}) AND ts >= ? GROUP BY site_id, b`)
      .bind(...siteIds, from),
    // Imported history: whole days, placed by the site's own timezone below.
    db
      .prepare(
        `SELECT d.site_id, d.day, d.visitors, d.revenue, s.timezone FROM imported_daily d JOIN sites s ON s.id = d.site_id
         WHERE d.site_id IN (${ids}) AND d.day >= ?`,
      )
      .bind(...siteIds, new Date(from - 2 * 86_400_000).toISOString().slice(0, 10)),
  ]);

  const byId = (rows: unknown[], field: string) => new Map((rows as any[]).map((r) => [r.site_id, r[field] as number]));
  const v = byId(totals.results, 'v');
  const r = byId(pay.results, 'r');
  const o = byId(online.results, 'n');
  const out = new Map(
    siteIds.map((id) => [
      id,
      { id, visitors: v.get(id) ?? 0, revenue: r.get(id) ?? 0, online: o.get(id) ?? 0, series: Array.from({ length: n }, () => ({ visitors: 0, revenue: 0 })) },
    ]),
  );
  for (const row of vs.results as any[]) out.get(row.site_id)!.series[row.b].visitors = row.v;
  for (const row of rs.results as any[]) out.get(row.site_id)!.series[row.b].revenue = row.r;
  for (const row of imported.results as { site_id: string; day: string; visitors: number; revenue: number; timezone: string }[]) {
    // A day counts where its middle falls, so a window that starts mid-day takes the day only if most of it is inside.
    const utcMidnight = Date.parse(row.day + 'T00:00:00Z');
    const mid = utcMidnight - tzOffset(row.timezone, utcMidnight) + 43_200_000;
    if (mid < from || mid >= now) continue;
    const s = out.get(row.site_id)!;
    const b = Math.min(n - 1, Math.floor((mid - from) / width));
    s.visitors += row.visitors;
    s.revenue += row.revenue;
    s.series[b].visitors += row.visitors;
    s.series[b].revenue += row.revenue;
  }
  return [...out.values()];
}
