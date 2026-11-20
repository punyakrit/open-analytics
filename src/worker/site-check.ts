/**
 * The robots.txt and sitemap check on the Search & AI tab. Unlike the rest of the tab it fetches from the site
 * itself: robots.txt (which crawlers it shuts out) and the sitemap (every page the site says it has), then
 * compares the sitemap with the crawler visits on record to find pages Google or AI search never read.
 *
 * Fetching takes a few seconds, so the result is kept for CACHE_MS and the tab loads it separately.
 */
import { CRAWLERS } from '../shared/bots';
import type { Env, Site } from './env';
import { isProbe, sortFindings, WATCH, type Finding } from './insights';

const DAY = 86_400_000;
const CACHE_MS = 12 * 3_600_000;
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 3_000_000;
/** Sitemap files read per check, in all: enough for a good sample, few enough to stay quick. */
const MAX_SITEMAP_FETCHES = 12;
const MAX_CHECKED = 1_500;
/** Coverage needs this much crawler history: crawlers revisit most pages over a couple of weeks, not days. */
const MIN_HISTORY_DAYS = 14;
const UA = 'Mozilla/5.0 (compatible; OpenAnalyticsSiteCheck/1.0; +https://github.com/punyakrit/open-analytics)';

/** Crawlers whose visits mean "this page can show up in AI answers": the answer fetchers and AI search indexes. */
const AI_SEARCH = CRAWLERS.filter((c) => c.kind === 'answers' || ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot'].includes(c.agent)).map((c) => c.agent);

export interface SiteCheck {
  checked_at: number;
  robots: { url: string; found: boolean; status: number | null; blocked: { agent: string; product: string }[] };
  sitemap: {
    found: boolean;
    sources: string[];
    total: number; // pages listed (estimated when only some child sitemaps were read)
    atLeast: boolean; // a sitemap was too big to read whole, so `total` is a lower bound
    checked: number; // pages compared with crawler visits
    days: number; // crawler history the comparison covers
    notGoogle: number;
    notAi: number;
    unread: string[]; // read by neither, a few examples
  };
  findings: Finding[];
}

// ---------- robots.txt

interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

export function parseRobots(text: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      // Consecutive User-agent lines share the rules that follow them.
      if (!current || !lastWasAgent) groups.push((current = { agents: [], allow: [], disallow: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' && value) current.allow.push(value);
    if (field === 'disallow' && value) current.disallow.push(value);
  }
  return { groups, sitemaps };
}

/** Does robots.txt shut this crawler out of the whole site? The group naming it applies, else the `*` group. */
export function blocksWholeSite(robots: { groups: RobotsGroup[] }, agent: string): boolean {
  const token = agent.toLowerCase();
  let groups = robots.groups.filter((g) => g.agents.includes(token));
  if (!groups.length) groups = robots.groups.filter((g) => g.agents.includes('*'));
  if (!groups.length) return false;
  const whole = (p: string) => p === '/' || p === '/*';
  return groups.some((g) => g.disallow.some(whole)) && !groups.some((g) => g.allow.some(whole));
}

// ---------- sitemaps

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

export function parseSitemap(xml: string): { index: boolean; locs: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
    m[1].replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e]),
  );
  return { index: /<sitemapindex[\s>]/i.test(xml), locs };
}

/** `n` items spread evenly over the list, so a sample of a big sitemap covers all of it, not just the start. */
export function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]);
}

async function fetchText(url: string): Promise<{ status: number | null; text: string | null; truncated?: boolean }> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/plain, application/xml, text/xml, */*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok || !res.body) return { status: res.status, text: null };
    const gzipped = /\.gz$/i.test(new URL(url).pathname) && !/text|xml/i.test(res.headers.get('content-type') ?? '');
    const body = gzipped ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body;
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += value;
      if (text.length > MAX_BYTES) {
        await reader.cancel();
        return { status: res.status, text, truncated: true };
      }
    }
    return { status: res.status, text };
  } catch {
    return { status: null, text: null };
  }
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');
const keyOf = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/**
 * The site's pages from its sitemap(s): a spread sample of paths, and how many the sitemaps list in all.
 * Sitemaps are read level by level (robots.txt's list, then the children of any index), each level in
 * parallel, never the same file twice, within MAX_SITEMAP_FETCHES. Children left unread are estimated from
 * the ones that were.
 */
async function sitemapPages(domain: string, declared: string[]) {
  const seen = new Set<string>();
  const sources: string[] = [];
  const pageUrls: string[] = [];
  let level = declared.length ? declared : [`https://${domain}/sitemap.xml`, `https://${domain}/sitemap_index.xml`];
  let budget = MAX_SITEMAP_FETCHES;
  let listed = 0;
  let pageSitemaps = 0;
  let unread = 0;
  let atLeast = false;
  for (let depth = 0; depth < 3 && level.length && budget > 0; depth++) {
    const todo = [...new Set(level)].filter((u) => !seen.has(u));
    const batch = spread(todo, budget);
    unread += todo.length - batch.length;
    budget -= batch.length;
    batch.forEach((u) => seen.add(u));
    const next: string[] = [];
    const fetched = await Promise.all(batch.map((u) => fetchText(u)));
    fetched.forEach((r, i) => {
      if (!r.text) return;
      const { index, locs } = parseSitemap(r.text);
      if (!locs.length) return;
      sources.push(batch[i]);
      if (r.truncated) atLeast = true;
      if (index) next.push(...locs);
      else {
        pageSitemaps++;
        listed += locs.length;
        pageUrls.push(...locs);
      }
    });
    level = next;
  }
  unread += level.filter((u) => !seen.has(u)).length;
  const total = listed + (pageSitemaps && unread ? Math.round((listed / pageSitemaps) * unread) : 0);
  const host = bareHost(domain);
  const paths = new Set<string>();
  for (const u of pageUrls) {
    try {
      const url = new URL(u);
      if (bareHost(url.hostname) === host && !isProbe(url.pathname)) paths.add(keyOf(url.pathname));
    } catch {
      // Not a URL: skip it.
    }
  }
  return { sources, total, atLeast: atLeast || unread > 0, paths: spread([...paths], MAX_CHECKED) };
}

/** Of these paths, which ones Google and AI search crawlers read since `since`. */
async function readBy(db: D1Database, siteId: string, paths: string[], since: number) {
  const google = new Set<string>();
  const ai = new Set<string>();
  const chunks: string[][] = [];
  // Each path as listed and with a trailing slash, since sites serve one and redirect the other. 45 per query
  // keeps the bound values under D1's limit of 100.
  for (let i = 0; i < paths.length; i += 45) chunks.push(paths.slice(i, i + 45));
  const aiList = AI_SEARCH.map((a) => `'${a}'`).join(', ');
  const results = await db.batch(
    chunks.map((chunk) => {
      const variants = chunk.flatMap((p) => (p === '/' ? [p] : [p, p + '/']));
      return db
        .prepare(
          `SELECT path, MAX(agent = 'Googlebot') AS google, MAX(agent IN (${aiList})) AS ai FROM crawls
           WHERE site_id = ? AND path IN (${variants.map(() => '?').join(', ')}) AND ts >= ? GROUP BY path`,
        )
        .bind(siteId, ...variants, since);
    }),
  );
  for (const r of results.flatMap((x) => x.results as { path: string; google: number; ai: number }[])) {
    if (r.google) google.add(keyOf(r.path));
    if (r.ai) ai.add(keyOf(r.path));
  }
  return { google, ai };
}

// ---------- the check

export async function runSiteCheck(env: Env, site: Site): Promise<SiteCheck> {
  const now = Date.now();
  const robotsUrl = `https://${site.domain}/robots.txt`;
  const robotsRes = await fetchText(robotsUrl);
  const robots = parseRobots(robotsRes.text ?? '');
  const watched = WATCH.flatMap((w) => w.agents.map((agent) => ({ agent, product: w.name })));
  const blocked = robotsRes.text ? watched.filter((w) => blocksWholeSite(robots, w.agent)) : [];

  const pages = await sitemapPages(site.domain, robots.sitemaps);
  const first = await env.DB.prepare('SELECT MIN(ts) AS first FROM crawls WHERE site_id = ?').bind(site.id).first<{ first: number | null }>();
  const since = Math.max(now - 30 * DAY, first?.first ?? now);
  const days = Math.floor((now - since) / DAY);
  const read = first?.first && pages.paths.length ? await readBy(env.DB, site.id, pages.paths, since) : { google: new Set<string>(), ai: new Set<string>() };
  const unread = pages.paths.filter((p) => !read.google.has(p) && !read.ai.has(p));

  const check: Omit<SiteCheck, 'findings'> = {
    checked_at: now,
    robots: { url: robotsUrl, found: !!robotsRes.text, status: robotsRes.status, blocked },
    sitemap: {
      found: pages.sources.length > 0,
      sources: pages.sources,
      total: pages.total,
      atLeast: pages.atLeast,
      checked: pages.paths.length,
      days,
      notGoogle: pages.paths.filter((p) => !read.google.has(p)).length,
      notAi: pages.paths.filter((p) => !read.ai.has(p)).length,
      unread: unread.slice(0, 8),
    },
  };
  return { ...check, findings: siteCheckFindings(check, site.domain, !!first?.first) };
}

export function siteCheckFindings(c: Omit<SiteCheck, 'findings'>, domain: string, tracking: boolean): Finding[] {
  const out: Finding[] = [];
  if (c.robots.blocked.length) {
    const products = [...new Set(c.robots.blocked.map((b) => b.product))];
    out.push({
      id: 'robots-blocks',
      tone: 'fix',
      title: `robots.txt shuts out ${products.join(', ').replace(/, ([^,]*)$/, ' and $1')}`,
      body:
        `Your robots.txt tells ${c.robots.blocked.map((b) => b.agent).join(', ')} not to read any page, so your site can't show up in their answers or results. ` +
        'Unless that\'s on purpose, allow them. If your site is behind Cloudflare, its AI crawler settings (a managed robots.txt, "Block AI bots") can add these rules for you.',
      code: `# robots.txt: let these read your site\n${c.robots.blocked.map((b) => `User-agent: ${b.agent}`).join('\n')}\nAllow: /`,
    });
  }
  if (!c.sitemap.found) {
    out.push({
      id: 'no-sitemap',
      tone: 'idea',
      title: 'No sitemap found',
      body: "Neither robots.txt nor /sitemap.xml points to one. A sitemap lists every page, so Google, Bing and AI search find the ones that aren't well linked. Most frameworks can generate it; then add its address to robots.txt.",
      code: `# robots.txt\nSitemap: https://${domain}/sitemap.xml`,
    });
  } else if (tracking && c.sitemap.checked >= 20 && c.sitemap.days >= MIN_HISTORY_DAYS) {
    const share = (n: number) => n / c.sitemap.checked;
    const worst = share(c.sitemap.notGoogle) >= share(c.sitemap.notAi) ? { who: 'Google', n: c.sitemap.notGoogle } : { who: 'AI search', n: c.sitemap.notAi };
    if (share(worst.n) >= 0.2) {
      const sample =
        c.sitemap.checked < c.sitemap.total ? ` (a sample of ${c.sitemap.checked.toLocaleString('en')} of ${c.sitemap.total.toLocaleString('en')})` : '';
      out.push({
        id: 'sitemap-unread',
        tone: 'idea',
        title: `${Math.round(share(worst.n) * 100)}% of your sitemap pages haven't been read by ${worst.who} in ${c.sitemap.days} days`,
        body:
          `Of the sitemap pages checked${sample}, ${Math.round(share(c.sitemap.notGoogle) * 100)}% weren't read by Google and ${Math.round(share(c.sitemap.notAi) * 100)}% by AI search crawlers (ChatGPT, Claude, Perplexity). ` +
          "Pages crawlers never fetch can't rank or be cited. Link to them from pages that do get read (your homepage, popular pages), and check they aren't thin or near-duplicates.",
        pages: c.sitemap.unread.slice(0, 5).map((path) => ({ path, note: 'read by neither' })),
      });
    }
  }
  return sortFindings(out);
}

/** The cached check, or a fresh one when it's older than CACHE_MS (or `fresh` is asked for). */
export async function siteCheck(env: Env, site: Site, fresh = false): Promise<SiteCheck> {
  if (!fresh) {
    const row = await env.DB.prepare('SELECT checked_at, result FROM site_checks WHERE site_id = ?')
      .bind(site.id)
      .first<{ checked_at: number; result: string }>();
    if (row && row.checked_at > Date.now() - CACHE_MS) return JSON.parse(row.result) as SiteCheck;
  }
  const result = await runSiteCheck(env, site);
  await env.DB.prepare('INSERT OR REPLACE INTO site_checks (site_id, checked_at, result) VALUES (?, ?, ?)')
    .bind(site.id, result.checked_at, JSON.stringify(result))
    .run();
  return result;
}
