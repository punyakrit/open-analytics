import { describe, expect, it } from 'vitest';
import { findings, type InsightData } from '../src/worker/insights';

const base = (over: Partial<InsightData> = {}): InsightData => ({
  site: { id: 's1', domain: 'example.com', currency: 'USD' },
  totals: {
    ai: { visitors: 0, prev: 0, revenue: 0, customers: 0 },
    search: { visitors: 0, prev: 0, revenue: 0, customers: 0 },
    all: { visitors: 0, customers: 0, revenue: 0 },
  },
  sources: [],
  crawls: { answers: 0, indexing: 0, training: 0, tracking: 'server', missing: [], trainingAgents: [], started: [], stopped: [], statusReported: true, errors: [] },
  prevCovered: { visitors: true, crawls: true },
  goals: [],
  pages: [],
  rangeDays: 30,
  ...over,
});
const ids = (d: InsightData) => findings(d).map((f) => f.id);

describe('Search & AI to-do list', () => {
  it('asks for crawler tracking first when there is none, and only the script', () => {
    expect(ids(base({ crawls: { ...base().crawls, tracking: 'none' } }))[0]).toBe('no-crawlers');
    expect(ids(base({ crawls: { ...base().crawls, tracking: 'script' } }))[0]).toBe('script-only');
  });

  it('names crawlers that stopped coming, with robots.txt lines to allow them', () => {
    const f = findings(base({ crawls: { ...base().crawls, missing: ['Perplexity', 'Claude'] } }))[0];
    expect(f.title).toBe("Perplexity and Claude haven't visited in 30 days");
    expect(f.code).toContain('User-agent: PerplexityBot');
    expect(f.code).toContain('Allow: /');
  });

  it('lists pages AI reads that send nobody, most-read first', () => {
    const pages = [
      { path: '/a', fetches: 130, ai_visitors: 0, search_visitors: 0, revenue: 0 },
      { path: '/b', fetches: 40, ai_visitors: 3, search_visitors: 0, revenue: 0 },
      { path: '/c', fetches: 6, ai_visitors: 0, search_visitors: 2, revenue: 0 },
      { path: '/d', fetches: 2, ai_visitors: 0, search_visitors: 0, revenue: 0 },
    ];
    const f = findings(base({ pages })).find((x) => x.id === 'read-not-clicked')!;
    expect(f.pages?.map((p) => p.path)).toEqual(['/a', '/c']);
    expect(f.pages?.[0].note).toBe('read 130 times, 0 visitors');
  });

  it('says when AI sends more than search, and flags a big drop', () => {
    const d = base({
      totals: { ...base().totals, ai: { visitors: 272, prev: 500, revenue: 0, customers: 0 }, search: { visitors: 97, prev: 90, revenue: 0, customers: 0 } },
      sources: [{ source: 'ChatGPT', channel: 'AI', visitors: 260, prev: 0, revenue: 0 }],
    });
    const all = findings(d);
    expect(all.find((f) => f.id === 'ai-beats-search')?.body).toContain('ChatGPT alone sent 260');
    const only = { ...d, sources: [{ source: 'ChatGPT', channel: 'AI', visitors: 272, prev: 0, revenue: 0 }] };
    expect(findings(only).find((f) => f.id === 'ai-beats-search')?.body).toContain('all of them from ChatGPT');
    expect(all.find((f) => f.id === 'ai-trend')).toMatchObject({ tone: 'idea', title: 'Visitors from AI are down 46%' });
  });

  it('compares how often AI visitors buy with the site average', () => {
    const totals = (aiCustomers: number) => ({
      ai: { visitors: 400, prev: 0, revenue: 0, customers: aiCustomers },
      search: { visitors: 0, prev: 0, revenue: 0, customers: 0 },
      all: { visitors: 1000, customers: 10, revenue: 0 },
    });
    expect(ids(base({ totals: totals(12) }))).toContain('ai-converts');
    expect(findings(base({ totals: totals(0) })).find((f) => f.id === 'ai-not-converting')?.title).toBe("Visitors from AI haven't bought anything yet");
    // RemJobs: 9 customers in 23,000 visitors, so 276 AI visitors with none is expected, not a problem.
    const rare = { ...totals(0), ai: { visitors: 276, prev: 0, revenue: 0, customers: 0 }, all: { visitors: 23_000, customers: 9, revenue: 0 } };
    expect(ids(base({ totals: rare }))).not.toContain('ai-not-converting');
  });

  it('offers to block training crawlers only when they dwarf answers', () => {
    const crawls = { ...base().crawls, training: 55_000, answers: 4_000, trainingAgents: ['GPTBot', 'ClaudeBot'] };
    expect(findings(base({ crawls })).find((f) => f.id === 'training')?.code).toContain('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /');
    expect(ids(base({ crawls: { ...crawls, training: 900 } }))).not.toContain('training');
  });

  it('puts fixes first and says so when there is nothing to fix', () => {
    const order = findings(base({ crawls: { ...base().crawls, missing: ['Bing'] }, pages: [{ path: '/w', fetches: 0, ai_visitors: 5, search_visitors: 1, revenue: 900 }] }));
    expect(order.map((f) => f.tone)).toEqual(['fix', 'good']);
    expect(ids(base())[0]).toBe('all-good');
  });
});

describe('pages that are really scanner probes', async () => {
  const { isProbe } = await import('../src/worker/insights');
  it('leaves out secret-hunting requests but keeps real pages', () => {
    for (const p of ['/api/proc/self/environ', '/api/config', '/.env', '/wp-admin/setup.php', '/config.yml', '/.git/config', '/phpinfo.php'])
      expect(isProbe(p), p).toBe(true);
    for (const p of ['/', '/pricing', '/blog/environment-setup', '/jobs/australia/data', '/mcp', '/company/config-careers', '/docs/api'])
      expect(isProbe(p), p).toBe(false);
  });
});

describe('new Search & AI rules', () => {
  const visitors = (ai: number, all: number) => ({
    ...base().totals,
    ai: { visitors: ai, prev: 0, revenue: 0, customers: 0 },
    all: { visitors: all, customers: 0, revenue: 0 },
  });

  it('compares goals of AI visitors with everyone, only when the gap is meaningful', () => {
    // signup: 2% overall; AI visitors 6%. 300 AI visitors would make 6 at the usual rate, so it counts.
    const d = base({ totals: visitors(300, 20_000), goals: [{ name: 'signup', all: 400, ai: 18, search: 0 }] });
    expect(findings(d).find((f) => f.id === 'ai-goal-gap')).toMatchObject({ tone: 'good', title: 'Visitors from AI complete “signup” 3× as often' });
    const low = base({ totals: visitors(300, 20_000), goals: [{ name: 'signup', all: 400, ai: 1, search: 0 }] });
    expect(findings(low).find((f) => f.id === 'ai-goal-gap')).toMatchObject({ tone: 'idea', title: 'Visitors from AI rarely complete “signup”' });
    // A rare goal: 300 AI visitors would make 0.3 at the usual rate, so no claim either way.
    const rare = base({ totals: visitors(300, 20_000), goals: [{ name: 'checkout', all: 20, ai: 0, search: 0 }] });
    expect(ids(rare)).not.toContain('ai-goal-gap');
  });

  it('lists pages AI started and stopped reading', () => {
    const crawls = { ...base().crawls, started: [{ path: '/new', n: 9 }, { path: '/once', n: 1 }], stopped: [{ path: '/gone', prev: 40 }] };
    const all = findings(base({ crawls }));
    expect(all.find((f) => f.id === 'ai-started-reading')?.pages).toEqual([{ path: '/new', note: 'read 9 times' }]);
    expect(all.find((f) => f.id === 'ai-stopped-reading')?.pages).toEqual([{ path: '/gone', note: 'read 40 times before, 0 now' }]);
  });

  it('reports broken and missing pages crawlers hit, naming the crawlers', () => {
    const errors = [
      { path: '/old-job', status: 404, n: 12, agents: ['ChatGPT-User', 'Googlebot'] },
      { path: '/search', status: 500, n: 3, agents: ['bingbot'] },
    ];
    const all = findings(base({ crawls: { ...base().crawls, errors } }));
    expect(all.find((f) => f.id === 'crawl-not-found')?.pages?.[0]).toEqual({ path: '/old-job', note: '404, 12 times (ChatGPT and Google)' });
    expect(all.find((f) => f.id === 'crawl-server-errors')?.title).toBe('Crawlers got server errors on 1 page');
  });

  it("doesn't compare with a period tracking didn't cover", () => {
    const totals = { ...base().totals, ai: { visitors: 300, prev: 20, revenue: 0, customers: 0 } };
    expect(ids(base({ totals }))).toContain('ai-trend');
    expect(ids(base({ totals, prevCovered: { visitors: false, crawls: false } }))).not.toContain('ai-trend');
  });

  it('suggests sending response codes when the snippet does not', () => {
    expect(ids(base({ crawls: { ...base().crawls, statusReported: false } }))).toContain('report-status');
  });
});

describe('robots.txt and sitemaps', async () => {
  const { parseRobots, blocksWholeSite, parseSitemap, spread, siteCheckFindings } = await import('../src/worker/site-check');

  it('reads which crawlers robots.txt shuts out', () => {
    const robots = parseRobots(`# Cloudflare managed
User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /

User-agent: PerplexityBot
Disallow: /private
Allow: /

User-agent: OAI-SearchBot
Disallow: /

User-agent: *
Disallow: /admin
Sitemap: https://example.com/sitemap.xml`);
    expect(blocksWholeSite(robots, 'GPTBot')).toBe(true);
    expect(blocksWholeSite(robots, 'ClaudeBot')).toBe(true);
    expect(blocksWholeSite(robots, 'OAI-SearchBot')).toBe(true);
    expect(blocksWholeSite(robots, 'PerplexityBot')).toBe(false);
    expect(blocksWholeSite(robots, 'Googlebot')).toBe(false); // falls back to *, which only hides /admin
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(blocksWholeSite(parseRobots('User-agent: *\nDisallow: /'), 'bingbot')).toBe(true);
    expect(blocksWholeSite(parseRobots('User-agent: *\nDisallow:'), 'bingbot')).toBe(false);
  });

  it('reads sitemaps and sitemap indexes', () => {
    expect(parseSitemap('<urlset><url><loc>https://a.com/x?a=1&amp;b=2</loc></url><url><loc><![CDATA[https://a.com/y]]></loc></url></urlset>')).toEqual({
      index: false,
      locs: ['https://a.com/x?a=1&b=2', 'https://a.com/y'],
    });
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>').index).toBe(true);
    expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toEqual([1, 3, 5, 7, 9]);
  });

  it('turns the check into to-dos, waiting for enough crawler history', () => {
    const check = {
      checked_at: 0,
      robots: { url: '', found: true, status: 200, blocked: [{ agent: 'OAI-SearchBot', product: 'ChatGPT' }, { agent: 'PerplexityBot', product: 'Perplexity' }] },
      sitemap: { found: true, sources: [], total: 100, atLeast: false, checked: 100, days: 30, notGoogle: 40, notAi: 70, unread: ['/a', '/b'] },
    };
    const out = siteCheckFindings(check, 'example.com', true);
    expect(out[0]).toMatchObject({ id: 'robots-blocks', title: 'robots.txt shuts out ChatGPT and Perplexity' });
    expect(out[1].title).toBe("70% of your sitemap pages haven't been read by AI search in 30 days");
    expect(siteCheckFindings({ ...check, sitemap: { ...check.sitemap, days: 6 } }, 'example.com', true).map((f) => f.id)).toEqual(['robots-blocks']);
    expect(siteCheckFindings({ ...check, robots: { ...check.robots, blocked: [] }, sitemap: { ...check.sitemap, found: false } }, 'example.com', true)[0].code).toBe(
      '# robots.txt\nSitemap: https://example.com/sitemap.xml',
    );
  });
});
