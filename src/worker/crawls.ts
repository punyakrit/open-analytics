/**
 * Crawler visits: recording them (from the site's server, or from the script for crawlers that run
 * JavaScript) and the numbers behind the dashboard's crawler panel.
 */
import type { Context } from 'hono';
import { crawlerFor, type CrawlKind } from '../shared/bots';
import type { AppEnv, Site } from './env';
import { bucketLabels, bucketSql } from './lib/time';
import { siteFromApiKey } from './payments';
import type { makeCtx } from './stats';

const KINDS = new Set<CrawlKind>(['answers', 'indexing', 'training']);
/** Rows older than this are removed by the cron job. */
export const CRAWL_RETENTION_MS = 400 * 86_400_000;

function cleanPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      path = new URL(raw).pathname;
    } catch {
      return null;
    }
  }
  path = path.split(/[?#]/)[0];
  return path.startsWith('/') ? path.slice(0, 500) : null;
}

const cleanCountry = (raw: unknown) => (typeof raw === 'string' && /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null);

export function recordCrawl(db: D1Database, site: Site, userAgent: string, path: string, country: string | null, ts = Date.now()) {
  const bot = crawlerFor(userAgent);
  if (!bot) return null;
  return db
    .prepare('INSERT INTO crawls (site_id, ts, agent, kind, path, country) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(site.id, ts, bot.agent, bot.kind, path, country)
    .run()
    .then(() => bot);
}

/**
 * POST /api/v1/crawls  Authorization: Bearer <site api key>
 * { "user_agent": "...GPTBot/1.2...", "path": "/pricing", "country": "US" }   ("url" works instead of "path")
 * Sent by the snippet in your site's server for each request from a known crawler. Anything that isn't a
 * known crawler is ignored, so sending every request is harmless (just wasteful).
 */
export async function handleCrawlApi(c: Context<AppEnv>) {
  const site = await siteFromApiKey(c);
  if (!site) return c.json({ error: 'invalid api key' }, 401);
  // Per site rather than per IP: every report comes from the same server, and crawlers arrive in bursts.
  if (c.env.CRAWL_LIMIT && !(await c.env.CRAWL_LIMIT.limit({ key: `crawl:${site.id}` })).success) {
    return c.json({ error: 'Too many requests' }, 429);
  }
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  const ua = typeof b?.user_agent === 'string' ? b.user_agent.slice(0, 1000) : '';
  const path = cleanPath(b?.path ?? b?.url);
  if (!ua || !path) return c.json({ error: 'user_agent and path (or url) are required' }, 400);
  const bot = await recordCrawl(c.env.DB, site, ua, path, cleanCountry(b?.country));
  return c.json(bot ? { ok: true, recorded: true, crawler: bot.name, kind: bot.kind } : { ok: true, recorded: false });
}

/** The crawler panel: totals per kind, then for one kind its crawlers, a chart per crawler and the pages they read. */
export async function crawlStats(ctx: ReturnType<typeof makeCtx>, kindParam: string | undefined) {
  const { db, site, range } = ctx;
  const kind: CrawlKind = KINDS.has(kindParam as CrawlKind) ? (kindParam as CrawlKind) : 'answers';
  const where = 'site_id = ? AND ts >= ? AND ts < ?';
  const args = [site.id, range.from, range.to];
  const b = bucketSql('ts', range.granularity, ctx.offset);
  const [totals, bots, series, pages] = await db.batch([
    db.prepare(`SELECT kind, COUNT(*) AS n FROM crawls WHERE ${where} GROUP BY kind`).bind(...args),
    db.prepare(`SELECT agent, COUNT(*) AS n FROM crawls WHERE ${where} AND kind = ? GROUP BY agent ORDER BY n DESC`).bind(...args, kind),
    db.prepare(`SELECT ${b} AS b, agent, COUNT(*) AS n FROM crawls WHERE ${where} AND kind = ? GROUP BY b, agent`).bind(...args, kind),
    db.prepare(`SELECT path, COUNT(*) AS n FROM crawls WHERE ${where} AND kind = ? GROUP BY path ORDER BY n DESC LIMIT 50`).bind(...args, kind),
  ]);
  const byBucket = new Map<string, Record<string, number>>();
  for (const r of series.results as { b: string; agent: string; n: number }[]) {
    const row = byBucket.get(r.b) ?? {};
    row[r.agent] = r.n;
    byBucket.set(r.b, row);
  }
  const count = Object.fromEntries((totals.results as { kind: string; n: number }[]).map((r) => [r.kind, r.n]));
  return {
    kind,
    granularity: range.granularity,
    totals: { answers: count.answers ?? 0, indexing: count.indexing ?? 0, training: count.training ?? 0 },
    bots: bots.results as { agent: string; n: number }[],
    series: bucketLabels(range, ctx.offset).map((bucket) => ({ bucket, ...(byBucket.get(bucket) ?? {}) })),
    pages: pages.results as { path: string; n: number }[],
  };
}
