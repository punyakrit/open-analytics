/**
 * The Search & AI tab: how much traffic AI assistants and search engines send, which pages AI reads and which
 * of those turn into visitors, sign-ups and revenue, and a short to-do list built from rules over that data.
 *
 * Everything comes from data already collected: sessions (channel AI / Organic Search), goals and payments of
 * those visitors, and crawler visits reported by the site's server. The robots.txt and sitemap check, which
 * fetches from the site itself, is in site-check.ts.
 */
import { crawlerByAgent } from '../shared/bots';
import { bucketLabels, bucketSql } from './lib/time';
import type { makeCtx } from './stats';

type Ctx = ReturnType<typeof makeCtx>;
const DAY = 86_400_000;
const CHANNELS = { ai: 'AI', search: 'Organic Search' } as const;

/** Crawlers that matter for being found, grouped by product. Missing ones for 30 days are worth a look. */
export const WATCH = [
  { name: 'ChatGPT', agents: ['OAI-SearchBot', 'ChatGPT-User'] },
  { name: 'Claude', agents: ['Claude-SearchBot', 'Claude-User'] },
  { name: 'Perplexity', agents: ['PerplexityBot', 'Perplexity-User'] },
  { name: 'Google', agents: ['Googlebot'] },
  { name: 'Bing', agents: ['bingbot'] },
];

/**
 * Requests that aren't pages: vulnerability scanners probing for secrets, often under a crawler's name
 * (StickyTray "had ChatGPT read" /api/proc/self/environ). Left out of the page lists.
 */
const PROBE =
  /(^|\/)(\.env|\.git|\.aws|\.ssh|\.well-known|wp-admin|wp-content|wp-includes|wp-login|xmlrpc|phpmyadmin|cgi-bin|proc|etc|vendor|node_modules)(\/|$|\.)|\.(php|asp|aspx|jsp|env|ini|sql|bak|log|ya?ml|cfg|conf)$|^\/api\/|^\/(config|admin|actuator|server-status)\b/i;
export const isProbe = (path: string) => PROBE.test(path);

/** Crawlers that sometimes run JavaScript, so the tracking script alone can report them. */
const JS_CRAWLERS = ['Googlebot', 'GoogleOther', 'bingbot', 'Applebot'];

export type Tone = 'fix' | 'idea' | 'good' | 'info';
export interface Finding {
  id: string;
  tone: Tone;
  title: string;
  body: string;
  pages?: { path: string; note: string }[];
  action?: { label: string; href: string };
  /** Something to paste, e.g. robots.txt lines. */
  code?: string;
}

export interface PageRow {
  path: string;
  fetches: number; // AI assistants opening the page to answer someone
  ai_visitors: number;
  search_visitors: number;
  revenue: number;
}

interface ChannelTotals {
  visitors: number;
  prev: number;
  revenue: number;
  customers: number;
}

export interface GoalRow {
  name: string;
  all: number; // visitors who completed it
  ai: number; // of them, visitors who came from an AI assistant in these dates
  search: number;
}

export interface CrawlError {
  path: string;
  status: number;
  n: number;
  agents: string[];
}

export interface InsightData {
  site: { id: string; domain: string; currency: string };
  totals: {
    ai: ChannelTotals;
    search: ChannelTotals;
    all: { visitors: number; customers: number; revenue: number };
  };
  /** Whether the period before is fully tracked, so comparisons with it mean something. */
  prevCovered: { visitors: boolean; crawls: boolean };
  sources: { source: string; channel: string; visitors: number; prev: number; revenue: number }[];
  crawls: {
    answers: number;
    indexing: number;
    training: number;
    tracking: 'none' | 'script' | 'server';
    missing: string[];
    trainingAgents: string[];
    /** Pages AI assistants started reading in these dates, and ones they stopped reading. */
    started: { path: string; n: number }[];
    stopped: { path: string; prev: number }[];
    /** Whether the server snippet reports response codes, and the pages crawlers got errors on. */
    statusReported: boolean;
    errors: CrawlError[];
  };
  goals: GoalRow[];
  pages: PageRow[];
  rangeDays: number;
}

export async function insights(ctx: Ctx) {
  const { db, site, range } = ctx;
  const span = range.to - range.from;
  const prevFrom = range.from - span;
  const now = Date.now();
  const inRange = [site.id, range.from, range.to];
  const inPrev = [site.id, prevFrom, range.from];
  const both = `('${CHANNELS.ai}', '${CHANNELS.search}')`;
  const b = bucketSql('started_at', range.granularity, ctx.offset);
  const visitorsFrom = (channel: string) =>
    `(SELECT DISTINCT visitor_id FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ? AND channel = '${channel}')`;

  const [
    bySource,
    prevBySource,
    allVisitors,
    landing,
    money,
    allMoney,
    series,
    crawlKinds,
    answerPages,
    prevAnswerPages,
    firstCrawl,
    firstSession,
    serverSnippet,
    goals,
    errors,
    statusSeen,
    ...lastSeen
  ] = await db.batch([
    db
      .prepare(
        `SELECT channel, source, COUNT(DISTINCT visitor_id) AS v FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ? GROUP BY channel, source`,
      )
      .bind(...inRange),
    db
      .prepare(
        `SELECT channel, source, COUNT(DISTINCT visitor_id) AS v FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ? AND channel IN ${both} GROUP BY channel, source`,
      )
      .bind(...inPrev),
    db.prepare(`SELECT COUNT(DISTINCT visitor_id) AS v FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?`).bind(...inRange),
    db
      .prepare(
        `SELECT entry_page AS path, channel, COUNT(DISTINCT visitor_id) AS v FROM sessions
         WHERE site_id = ? AND started_at >= ? AND started_at < ? AND channel IN ${both} GROUP BY entry_page, channel ORDER BY v DESC LIMIT 400`,
      )
      .bind(...inRange),
    db
      .prepare(
        `SELECT s.channel, s.source, s.entry_page AS path, SUM(p.amount) AS revenue,
                COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.id) END) AS customers
         FROM payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? GROUP BY s.channel, s.source, s.entry_page`,
      )
      .bind(...inRange),
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS revenue,
                COUNT(DISTINCT CASE WHEN kind = 'payment' AND renewal = 0 THEN COALESCE(visitor_id, id) END) AS customers
         FROM payments WHERE site_id = ? AND ts >= ? AND ts < ?`,
      )
      .bind(...inRange),
    db
      .prepare(
        `SELECT ${b} AS b, channel, COUNT(DISTINCT visitor_id) AS v FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ? AND channel IN ${both} GROUP BY b, channel`,
      )
      .bind(...inRange),
    db.prepare(`SELECT kind, agent, COUNT(*) AS n FROM crawls WHERE site_id = ? AND ts >= ? AND ts < ? GROUP BY kind, agent`).bind(...inRange),
    db
      .prepare(`SELECT path, COUNT(*) AS n FROM crawls WHERE site_id = ? AND ts >= ? AND ts < ? AND kind = 'answers' GROUP BY path ORDER BY n DESC LIMIT 300`)
      .bind(...inRange),
    db
      .prepare(`SELECT path, COUNT(*) AS n FROM crawls WHERE site_id = ? AND ts >= ? AND ts < ? AND kind = 'answers' GROUP BY path ORDER BY n DESC LIMIT 300`)
      .bind(...inPrev),
    db.prepare('SELECT MIN(ts) AS first FROM crawls WHERE site_id = ?').bind(site.id),
    db.prepare('SELECT MIN(started_at) AS first FROM sessions WHERE site_id = ?').bind(site.id),
    db
      .prepare(`SELECT 1 AS yes FROM crawls WHERE site_id = ? AND ts >= ? AND agent NOT IN (${JS_CRAWLERS.map(() => '?').join(', ')}) LIMIT 1`)
      .bind(site.id, now - 30 * DAY, ...JS_CRAWLERS),
    // Goals completed in these dates, and how many of those visitors came from AI or search.
    db
      .prepare(
        `SELECT e.name, COUNT(DISTINCT e.visitor_id) AS all_v,
                COUNT(DISTINCT CASE WHEN a.visitor_id IS NOT NULL THEN e.visitor_id END) AS ai_v,
                COUNT(DISTINCT CASE WHEN q.visitor_id IS NOT NULL THEN e.visitor_id END) AS search_v
         FROM events e
         LEFT JOIN ${visitorsFrom(CHANNELS.ai)} a ON a.visitor_id = e.visitor_id
         LEFT JOIN ${visitorsFrom(CHANNELS.search)} q ON q.visitor_id = e.visitor_id
         WHERE e.site_id = ? AND e.type = 'goal' AND e.name IS NOT NULL AND e.ts >= ? AND e.ts < ?
         GROUP BY e.name ORDER BY all_v DESC LIMIT 8`,
      )
      .bind(...inRange, ...inRange, ...inRange),
    db
      .prepare(
        `SELECT path, status, COUNT(*) AS n, group_concat(DISTINCT agent) AS agents FROM crawls
         WHERE site_id = ? AND ts >= ? AND ts < ? AND status >= 400 GROUP BY path, status ORDER BY n DESC LIMIT 100`,
      )
      .bind(...inRange),
    db.prepare('SELECT 1 AS yes FROM crawls WHERE site_id = ? AND ts >= ? AND status IS NOT NULL LIMIT 1').bind(site.id, now - 30 * DAY),
    ...WATCH.flatMap((w) => w.agents).map((agent) =>
      db.prepare('SELECT ? AS agent, MAX(ts) AS last FROM crawls WHERE site_id = ? AND agent = ?').bind(agent, site.id, agent),
    ),
  ]);

  // ---- traffic from AI and search
  const sourceRows = bySource.results as { channel: string | null; source: string | null; v: number }[];
  const prevRows = prevBySource.results as { channel: string; source: string | null; v: number }[];
  const moneyRows = money.results as { channel: string | null; source: string | null; path: string | null; revenue: number; customers: number }[];
  const totalsFor = (channel: string): ChannelTotals => ({
    visitors: sourceRows.filter((r) => r.channel === channel).reduce((n, r) => n + r.v, 0),
    prev: prevRows.filter((r) => r.channel === channel).reduce((n, r) => n + r.v, 0),
    revenue: moneyRows.filter((r) => r.channel === channel).reduce((n, r) => n + (r.revenue ?? 0), 0),
    customers: moneyRows.filter((r) => r.channel === channel).reduce((n, r) => n + (r.customers ?? 0), 0),
  });
  const all = allMoney.results[0] as { revenue: number; customers: number };
  const totals = {
    ai: totalsFor(CHANNELS.ai),
    search: totalsFor(CHANNELS.search),
    all: { visitors: (allVisitors.results[0] as { v: number })?.v ?? 0, customers: all?.customers ?? 0, revenue: all?.revenue ?? 0 },
  };
  const sources = sourceRows
    .filter((r) => r.channel === CHANNELS.ai || r.channel === CHANNELS.search)
    .map((r) => ({
      source: r.source ?? 'Unknown',
      channel: r.channel!,
      visitors: r.v,
      prev: prevRows.find((p) => p.channel === r.channel && p.source === r.source)?.v ?? 0,
      revenue: moneyRows.filter((m) => m.channel === r.channel && m.source === r.source).reduce((n, m) => n + (m.revenue ?? 0), 0),
    }))
    .sort((a, b) => b.visitors - a.visitors || b.revenue - a.revenue);

  const byBucket = new Map<string, { ai: number; search: number }>();
  for (const r of series.results as { b: string; channel: string; v: number }[]) {
    const row = byBucket.get(r.b) ?? { ai: 0, search: 0 };
    row[r.channel === CHANNELS.ai ? 'ai' : 'search'] = r.v;
    byBucket.set(r.b, row);
  }

  // Comparisons with the period before only count when tracking already covered all of it.
  const firstCrawlTs = (firstCrawl.results[0] as { first: number | null })?.first ?? null;
  const firstSessionTs = (firstSession.results[0] as { first: number | null })?.first ?? null;
  const prevCovered = { visitors: firstSessionTs !== null && firstSessionTs <= prevFrom, crawls: firstCrawlTs !== null && firstCrawlTs <= prevFrom };

  // ---- crawlers
  const kindRows = crawlKinds.results as { kind: string; agent: string; n: number }[];
  const kindTotal = (k: string) => kindRows.filter((r) => r.kind === k).reduce((n, r) => n + r.n, 0);
  const seen = new Map((lastSeen.map((r) => r.results[0]) as { agent: string; last: number | null }[]).map((r) => [r.agent, r.last]));
  const tracking: InsightData['crawls']['tracking'] = !firstCrawlTs ? 'none' : serverSnippet.results.length ? 'server' : 'script';
  const missing = WATCH.filter((w) => w.agents.every((a) => !((seen.get(a) ?? 0) > now - 30 * DAY))).map((w) => w.name);
  const trainingAgents = [
    ...new Set(
      kindRows
        .filter((r) => r.kind === 'training')
        .sort((a, b) => b.n - a.n)
        .map((r) => r.agent),
    ),
  ];
  const nowReads = new Map((answerPages.results as { path: string; n: number }[]).filter((r) => !isProbe(r.path)).map((r) => [r.path, r.n]));
  const prevReads = new Map((prevAnswerPages.results as { path: string; n: number }[]).filter((r) => !isProbe(r.path)).map((r) => [r.path, r.n]));
  // Day to day, which pages get read churns; only a week or more says something.
  const compareReads = prevCovered.crawls && span >= 7 * DAY - 3_600_000;
  const started = compareReads ? [...nowReads].filter(([p]) => !prevReads.has(p)).map(([path, n]) => ({ path, n })) : [];
  const stopped = compareReads ? [...prevReads].filter(([p]) => !nowReads.has(p)).map(([path, prev]) => ({ path, prev })) : [];
  const crawlErrors = (errors.results as { path: string; status: number; n: number; agents: string | null }[])
    .filter((r) => !isProbe(r.path))
    .map((r) => ({ path: r.path, status: r.status, n: r.n, agents: (r.agents ?? '').split(',').filter(Boolean) }));

  // ---- pages: the ones AI reads, and the ones AI and search visitors land on
  const pageMap = new Map<string, PageRow>();
  const page = (path: string) => {
    let p = pageMap.get(path);
    if (!p) pageMap.set(path, (p = { path, fetches: 0, ai_visitors: 0, search_visitors: 0, revenue: 0 }));
    return p;
  };
  for (const [path, n] of nowReads) page(path).fetches = n;
  for (const r of landing.results as { path: string | null; channel: string; v: number }[]) {
    if (!r.path) continue;
    page(r.path)[r.channel === CHANNELS.ai ? 'ai_visitors' : 'search_visitors'] += r.v;
  }
  for (const r of moneyRows) {
    if (r.path && (r.channel === CHANNELS.ai || r.channel === CHANNELS.search) && pageMap.has(r.path)) page(r.path).revenue += r.revenue ?? 0;
  }
  // The pages that bring the most visitors, plus the ones AI reads most (often with no visitors at all).
  const candidates = [...pageMap.values()].filter((p) => p.path !== '/robots.txt' && !isProbe(p.path));
  const visitorsOf = (p: PageRow) => p.ai_visitors + p.search_visitors;
  const pages = [
    ...new Set([
      ...[...candidates].sort((a, b) => visitorsOf(b) - visitorsOf(a) || b.fetches - a.fetches).slice(0, 80),
      ...[...candidates].sort((a, b) => b.fetches - a.fetches).slice(0, 40),
    ]),
  ].sort((a, b) => visitorsOf(b) - visitorsOf(a) || b.fetches - a.fetches);

  const data: InsightData = {
    site: { id: site.id, domain: site.domain, currency: site.currency },
    totals,
    prevCovered,
    sources,
    crawls: {
      answers: kindTotal('answers'),
      indexing: kindTotal('indexing'),
      training: kindTotal('training'),
      tracking,
      missing,
      trainingAgents,
      started: started.sort((a, b) => b.n - a.n),
      stopped: stopped.sort((a, b) => b.prev - a.prev),
      statusReported: statusSeen.results.length > 0,
      errors: crawlErrors,
    },
    goals: (goals.results as { name: string; all_v: number; ai_v: number; search_v: number }[]).map((g) => ({
      name: g.name,
      all: g.all_v,
      ai: g.ai_v,
      search: g.search_v,
    })),
    pages,
    rangeDays: Math.max(1, Math.round(span / DAY)),
  };
  return {
    ...data,
    granularity: range.granularity,
    series: bucketLabels(range, ctx.offset).map((bucket) => ({ bucket, ...(byBucket.get(bucket) ?? { ai: 0, search: 0 }) })),
    todo: findings(data),
  };
}

const fmt = (n: number) => new Intl.NumberFormat('en').format(n);
const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const plural = (n: number, one: string, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
const pct = (r: number) => `${(r * 100).toFixed(r < 0.001 ? 2 : r < 0.1 ? 1 : 0)}%`;
const botNames = (agents: string[]) => [...new Set(agents.map((a) => crawlerByAgent(a)?.name ?? a))];
function money(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(0)} ${currency}`;
  }
}

/** The to-do list: things to fix first, then ideas, then what's working, then notes. */
export function findings(d: InsightData): Finding[] {
  const out: Finding[] = [];
  const setup = { label: 'Set up crawler tracking', href: `/site/${d.site.id}/settings#crawlers` };
  const { ai, search, all } = d.totals;

  if (d.crawls.tracking === 'none') {
    out.push({
      id: 'no-crawlers',
      tone: 'fix',
      title: 'See which pages AI assistants read',
      body: "ChatGPT, Claude, Perplexity and search engines read pages without running JavaScript, so the tracking script can't see them. A few lines in your server report them, and this page starts showing which pages they read and whether that brings visitors.",
      action: setup,
    });
  } else if (d.crawls.tracking === 'script') {
    out.push({
      id: 'script-only',
      tone: 'fix',
      title: "You're only seeing crawlers that run JavaScript",
      body: 'Google and Bing sometimes run the tracking script, so a few of their visits show up. AI assistants never do. Add the server snippet to see when ChatGPT, Claude and Perplexity read your pages.',
      action: setup,
    });
  } else if (d.crawls.missing.length) {
    const agents = d.crawls.missing.flatMap((name) => WATCH.find((w) => w.name === name)?.agents ?? []);
    out.push({
      id: 'missing-crawlers',
      tone: 'fix',
      title: `${list(d.crawls.missing)} ${d.crawls.missing.length === 1 ? "hasn't" : "haven't"} visited in 30 days`,
      body:
        "Other crawlers reach your site, so these may be blocked, or just haven't found it yet. Check that robots.txt doesn't disallow them and that bot protection at your host (like Cloudflare's \"Block AI bots\") lets them through. " +
        'Training crawlers (GPTBot, ClaudeBot, CCBot) are separate: you can block those and still show up in answers.',
      code: `# robots.txt: let these read your site\n${agents.map((a) => `User-agent: ${a}`).join('\n')}\nAllow: /`,
    });
  }

  // What crawlers got back, when the server snippet reports it.
  const broken = d.crawls.errors.filter((e) => e.status >= 500);
  const missingPages = d.crawls.errors.filter((e) => e.status === 404 || e.status === 410);
  const errorPages = (rows: CrawlError[]) =>
    rows.slice(0, 5).map((e) => ({ path: e.path, note: `${e.status}, ${plural(e.n, 'time')} (${list(botNames(e.agents).slice(0, 3))})` }));
  if (broken.length) {
    out.push({
      id: 'crawl-server-errors',
      tone: 'fix',
      title: `Crawlers got server errors on ${plural(broken.length, 'page')}`,
      body: 'Your server failed when AI or search crawlers asked for these pages. Crawlers that keep getting errors come back less often and may drop the page.',
      pages: errorPages(broken),
    });
  }
  if (missingPages.length) {
    out.push({
      id: 'crawl-not-found',
      tone: 'fix',
      title: `Crawlers keep asking for ${plural(missingPages.length, 'page')} that ${missingPages.length === 1 ? "doesn't" : "don't"} exist`,
      body: 'Something still links to these: your own pages, your sitemap or other sites. Redirect each one to the closest page that exists, or remove the links.',
      pages: errorPages(missingPages),
    });
  }

  if (d.crawls.tracking === 'server') {
    const unread = d.pages.filter((p) => p.fetches >= 5 && p.ai_visitors === 0).sort((a, b) => b.fetches - a.fetches);
    const fetches = unread.reduce((n, p) => n + p.fetches, 0);
    if (unread.length && fetches >= 10) {
      out.push({
        id: 'read-not-clicked',
        tone: 'idea',
        title: 'AI reads these pages but sends nobody',
        body: "Assistants open these pages to answer people's questions, then answer without a click. Give people a reason to come: put what an answer can't include (live data, prices, a tool, a sign-up) near the top, and say it in the page title.",
        pages: unread.slice(0, 5).map((p) => ({ path: p.path, note: `read ${plural(p.fetches, 'time')}, 0 visitors` })),
      });
    }
    const stopped = d.crawls.stopped.filter((p) => p.prev >= 5);
    if (stopped.length) {
      out.push({
        id: 'ai-stopped-reading',
        tone: 'idea',
        title: `AI stopped reading ${plural(stopped.length, 'page')}`,
        body: `AI assistants read these in the ${d.rangeDays} days before and not at all now. Check they still load, weren't renamed or blocked, and are still linked from your site.`,
        pages: stopped.slice(0, 5).map((p) => ({ path: p.path, note: `read ${plural(p.prev, 'time')} before, 0 now` })),
      });
    }
    const started = d.crawls.started.filter((p) => p.n >= 3);
    if (started.length) {
      out.push({
        id: 'ai-started-reading',
        tone: 'good',
        title: `AI started reading ${plural(started.length, 'new page')}`,
        body: `Assistants didn't open these in the ${d.rangeDays} days before. If they're new, AI found them quickly; keep them linked and up to date.`,
        pages: started.slice(0, 5).map((p) => ({ path: p.path, note: `read ${plural(p.n, 'time')}` })),
      });
    }
  }

  // Do visitors from AI buy?
  if (all.visitors >= 100 && all.customers >= 3 && ai.visitors >= 50) {
    const aiRate = ai.customers / ai.visitors;
    const siteRate = all.customers / all.visitors;
    // Only when the gap means something: at the site's usual rate, AI visitors should have made a few customers.
    const expected = ai.visitors * siteRate;
    if (aiRate >= siteRate * 1.5 && ai.customers >= 3) {
      out.push({
        id: 'ai-converts',
        tone: 'good',
        title: 'Visitors from AI buy more often than average',
        body: `${pct(aiRate)} of visitors from AI assistants became customers, against ${pct(siteRate)} across the site. Being recommended by AI is worth more to you than an average visit.`,
      });
    } else if (aiRate <= siteRate * 0.5 && expected >= 3) {
      out.push({
        id: 'ai-not-converting',
        tone: 'idea',
        title: ai.customers ? 'Visitors from AI rarely buy' : "Visitors from AI haven't bought anything yet",
        body: `${ai.customers ? pct(aiRate) : 'None'} of ${plural(ai.visitors, 'visitor')} from AI assistants became customers, against ${pct(siteRate)} across the site. Check the pages they land on (below) lead somewhere: a clear next step, pricing or a sign-up.`,
      });
    }
  }

  // Goals happen far more often than payments, so they show sooner whether AI visitors convert.
  const goal = goalGap(d);
  if (goal) out.push(goal);

  const winners = d.pages
    .filter((p) => p.ai_visitors + p.search_visitors >= 3)
    .sort((a, b) => b.revenue - a.revenue || b.ai_visitors + b.search_visitors - (a.ai_visitors + a.search_visitors))
    .slice(0, 5);
  if (winners.length) {
    out.push({
      id: 'winners',
      tone: 'good',
      title: 'These pages bring you visitors from AI and search',
      body: 'Keep them accurate and current, link to them from your other pages, and write more pages like them.',
      pages: winners.map((p) => ({
        path: p.path,
        note: [
          p.ai_visitors && `${fmt(p.ai_visitors)} from AI`,
          p.search_visitors && `${fmt(p.search_visitors)} from search`,
          p.revenue > 0 && money(p.revenue, d.site.currency),
        ]
          .filter(Boolean)
          .join(', '),
      })),
    });
  }

  if (ai.visitors >= 10 && ai.visitors > search.visitors) {
    const top = d.sources.find((s) => s.channel === CHANNELS.ai);
    out.push({
      id: 'ai-beats-search',
      tone: 'info',
      title: 'AI assistants send you more visitors than search engines',
      body: `${fmt(ai.visitors)} visitors came from AI assistants and ${fmt(search.visitors)} from search engines in these dates${top ? (top.visitors === ai.visitors ? `, all of them from ${top.source}` : `; ${top.source} alone sent ${fmt(top.visitors)}`) : ''}. Being the page an assistant cites is now worth as much as ranking in search.`,
    });
  }
  const change = (now: number, before: number) => (d.prevCovered.visitors && before >= 10 ? (now - before) / before : null);
  const aiChange = change(ai.visitors, ai.prev);
  if (aiChange !== null && Math.abs(aiChange) >= 0.3) {
    out.push({
      id: 'ai-trend',
      tone: aiChange > 0 ? 'good' : 'idea',
      title: `Visitors from AI are ${aiChange > 0 ? 'up' : 'down'} ${Math.round(Math.abs(aiChange) * 100)}%`,
      body:
        `${fmt(ai.visitors)} in these dates against ${fmt(ai.prev)} in the ${d.rangeDays} days before.` +
        (aiChange < 0 ? ' If a crawler has stopped coming (see above), that is the first thing to check.' : ''),
    });
  }

  if (d.crawls.training >= 1000 && d.crawls.training > d.crawls.answers * 5) {
    const agents = d.crawls.trainingAgents.slice(0, 6);
    out.push({
      id: 'training',
      tone: 'info',
      title: `Training crawlers read ${plural(d.crawls.training, 'page')}`,
      body: `They collect pages for future AI models and don't send visitors. If they cost you bandwidth or you'd rather not be used for training, you can block them. Answers and search use other crawlers, so this won't hide you from ChatGPT, Claude or Perplexity.`,
      code: `# robots.txt: stop AI training crawlers\n${agents.map((a) => `User-agent: ${a}`).join('\n')}\nDisallow: /`,
    });
  }
  if (d.crawls.tracking === 'server' && !d.crawls.statusReported) {
    out.push({
      id: 'report-status',
      tone: 'info',
      title: 'Also report what crawlers get back',
      body: 'Send the response code with each crawler visit and this list will show the broken and missing pages AI and search crawlers run into. The updated snippets in Settings do it; the old ones keep working.',
      action: { label: 'See the snippets', href: `/site/${d.site.id}/settings#crawlers` },
    });
  }

  if (!out.some((f) => f.tone === 'fix' || f.tone === 'idea')) {
    out.unshift({
      id: 'all-good',
      tone: 'good',
      title: 'Nothing to fix right now',
      body: 'No problems found in these dates: the crawlers that matter are reaching your site. Check back after you publish new pages.',
    });
  }
  return sortFindings(out);
}

const ORDER: Record<Tone, number> = { fix: 0, idea: 1, good: 2, info: 3 };
export const sortFindings = (list: Finding[]) => [...list].sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);

/**
 * The goal where visitors from AI differ most from everyone else, when the difference means something: at the
 * site's usual rate, AI visitors should have completed it at least 5 times.
 */
function goalGap(d: InsightData): Finding | null {
  const { ai, all } = d.totals;
  if (ai.visitors < 30 || all.visitors < 100) return null;
  let best: { g: GoalRow; aiRate: number; siteRate: number; ratio: number } | null = null;
  for (const g of d.goals) {
    const siteRate = g.all / all.visitors;
    if (ai.visitors * siteRate < 5) continue;
    const aiRate = g.ai / ai.visitors;
    const ratio = aiRate / siteRate;
    if (ratio < 1.5 && ratio > 0.6) continue;
    if (!best || Math.abs(Math.log(ratio || 0.01)) > Math.abs(Math.log(best.ratio || 0.01))) best = { g, aiRate, siteRate, ratio };
  }
  if (!best) return null;
  const { g, aiRate, siteRate, ratio } = best;
  const times = ratio >= 2 ? `${ratio.toFixed(ratio >= 10 ? 0 : 1).replace(/\.0$/, '')}× as often` : 'more often';
  return ratio > 1
    ? {
        id: 'ai-goal-gap',
        tone: 'good',
        title: `Visitors from AI complete “${g.name}” ${times}`,
        body: `${pct(aiRate)} of visitors from AI assistants did, against ${pct(siteRate)} of all visitors. People sent by an assistant arrive already looking for what you offer.`,
      }
    : {
        id: 'ai-goal-gap',
        tone: 'idea',
        title: `Visitors from AI rarely complete “${g.name}”`,
        body: `${pct(aiRate)} of visitors from AI assistants did, against ${pct(siteRate)} of all visitors. Check the pages they land on (below) lead to it.`,
      };
}
