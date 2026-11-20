import { useState, type ReactNode } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { navigate } from '../App';
import { api, qs } from '../lib/api';
import { useDash } from '../lib/context';
import { bucketLabel, fmtNumber } from '../lib/format';
import { useChartColors } from '../lib/theme';
import { useApi } from '../lib/useApi';
import { CodeBlock } from './CodeBlock';
import { SourceIcon } from './Icons';

type Tone = 'fix' | 'idea' | 'good' | 'info';
interface Finding {
  id: string;
  tone: Tone;
  title: string;
  body: string;
  pages?: { path: string; note: string }[];
  action?: { label: string; href: string };
  code?: string;
}
interface ChannelTotals {
  visitors: number;
  prev: number;
  revenue: number;
  customers: number;
}
interface PageRow {
  path: string;
  fetches: number;
  ai_visitors: number;
  search_visitors: number;
  revenue: number;
}
interface Insights {
  site: { domain: string };
  granularity: 'hour' | 'day' | 'week' | 'month';
  totals: {
    ai: ChannelTotals;
    search: ChannelTotals;
    all: { visitors: number };
  };
  sources: {
    source: string;
    channel: string;
    visitors: number;
    prev: number;
    revenue: number;
  }[];
  series: { bucket: string; ai: number; search: number }[];
  crawls: {
    answers: number;
    indexing: number;
    training: number;
    tracking: 'none' | 'script' | 'server';
  };
  prevCovered: { visitors: boolean; crawls: boolean };
  goals: { name: string; all: number; ai: number; search: number }[];
  pages: PageRow[];
  todo: Finding[];
}
interface SiteCheck {
  checked_at: number;
  robots: { url: string; found: boolean; status: number | null; blocked: { agent: string; product: string }[] };
  sitemap: { found: boolean; sources: string[]; total: number; atLeast: boolean; checked: number; days: number; notGoogle: number; notAi: number };
  findings: Finding[];
}
const TONE_ORDER: Record<Tone, number> = { fix: 0, idea: 1, good: 2, info: 3 };

// Checked for colour-blind separation and contrast against each theme's panel colour.
const LINE_COLORS = {
  light: { ai: '#5b7cfa', search: '#c26a12' },
  dark: { ai: '#5b7cfa', search: '#c27620' },
};
const TONES: Record<Tone, { label: string; chip: string }> = {
  fix: { label: 'Fix', chip: 'bg-red-50 text-red-600' },
  idea: { label: 'Idea', chip: 'bg-amber-50 text-amber-800' },
  good: { label: 'Working', chip: 'bg-emerald-50 text-emerald-800' },
  info: { label: 'Note', chip: 'bg-stone-100 text-stone-600' },
};

function Change({ now, before, covered }: { now: number; before: number; covered: boolean }) {
  // Before tracking started, "before" is just missing data, not a lower number.
  if (!covered || before < 5) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (!pct) return <span className="text-xs text-stone-400">same as before</span>;
  return (
    <span className={`num text-xs font-medium ${pct > 0 ? 'text-emerald-800' : 'text-red-600'}`}>
      {pct > 0 ? '+' : ''}
      {pct}% vs before
    </span>
  );
}

function Tile({ label, value, sub, swatch }: { label: string; value: ReactNode; sub?: ReactNode; swatch?: string }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="flex items-center gap-2 text-sm text-stone-500">
        {swatch && <span className="h-2 w-2 rounded-full" style={{ background: swatch }} />}
        {label}
      </div>
      <div className="num mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-0.5 h-4">{sub}</div>
    </div>
  );
}

/**
 * Search & AI: visitors from AI assistants and search engines, which pages AI reads and whether that brings
 * anyone, and a to-do list worked out from it (src/worker/insights.ts). Owner-only.
 */
export function SearchInsights() {
  const { site, base, q, reloadKey, money } = useDash();
  const color = useChartColors();
  const lines = LINE_COLORS[color.theme];
  const { data, loading } = useApi<Insights>(`${base}/${site.id}/insights?${qs({ ...q, filters: {} })}`, reloadKey);
  const [allPages, setAllPages] = useState(false);
  // robots.txt and the sitemap are fetched from the site, which takes a few seconds: loaded on its own.
  const check = useApi<SiteCheck>(`${base}/${site.id}/site-check`, reloadKey);
  const [rechecking, setRechecking] = useState(false);
  const recheck = async () => {
    setRechecking(true);
    try {
      check.setData(await api<SiteCheck>(`${base}/${site.id}/site-check`, { method: 'POST' }));
    } finally {
      setRechecking(false);
    }
  };

  if (!data) return <div className={`mt-5 h-[480px] rounded-xl bg-stone-100 ${loading ? 'animate-pulse' : ''}`} />;
  const { ai, search } = data.totals;
  const g = data.granularity;
  const pageUrl = (path: string) => `https://${data.site.domain}${path}`;
  const pages = allPages ? data.pages : data.pages.slice(0, 12);
  const noTraffic = !ai.visitors && !search.visitors;
  // The site check's to-dos (blocked crawlers, sitemap) join the rest; anything the "all good" note
  // contradicts drops it.
  const extra = check.data?.findings ?? [];
  const todo = [...(extra.some((f) => f.tone === 'fix' || f.tone === 'idea') ? data.todo.filter((f) => f.id !== 'all-good') : data.todo), ...extra].sort(
    (a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone],
  );
  const rate = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(n / of < 0.1 ? 1 : 0)}%` : '–');

  return (
    <div className="mt-5 space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="From AI assistants"
          swatch={lines.ai}
          value={fmtNumber(ai.visitors)}
          sub={<Change now={ai.visitors} before={ai.prev} covered={data.prevCovered.visitors} />}
        />
        <Tile
          label="From search engines"
          swatch={lines.search}
          value={fmtNumber(search.visitors)}
          sub={<Change now={search.visitors} before={search.prev} covered={data.prevCovered.visitors} />}
        />
        <Tile
          label="Pages read by AI"
          value={data.crawls.tracking === 'none' ? '–' : fmtNumber(data.crawls.answers)}
          sub={<span className="text-xs text-stone-400">{data.crawls.tracking === 'none' ? 'not tracked yet' : 'to answer someone'}</span>}
        />
        <Tile
          label="Revenue from AI & search"
          value={money(ai.revenue + search.revenue, true)}
          sub={<span className="text-xs text-stone-400">{ai.revenue ? `${money(ai.revenue, true)} from AI` : ' '}</span>}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="card">
          <h2 className="border-b border-stone-200 px-4 py-3 text-sm font-semibold">What to do</h2>
          <ul className="divide-y divide-stone-100">
            {todo.map((f) => (
              <li key={f.id} className="px-4 py-4">
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${TONES[f.tone].chip}`}>
                    {TONES[f.tone].label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium leading-snug">{f.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-stone-500">{f.body}</p>
                    {f.pages && (
                      <ul className="mt-2.5 space-y-1">
                        {f.pages.map((p) => (
                          <li key={p.path} className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
                            <a
                              className="min-w-0 truncate text-ink underline decoration-stone-300 underline-offset-2 hover:decoration-ink"
                              href={pageUrl(p.path)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {p.path}
                            </a>
                            <span className="num shrink-0 text-xs text-stone-500">{p.note}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {f.code && (
                      <div className="mt-3">
                        <CodeBlock label="robots.txt">{f.code}</CodeBlock>
                      </div>
                    )}
                    {f.action && (
                      <button className="btn mt-3" onClick={() => navigate(f.action!.href)}>
                        {f.action.label}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <div className="space-y-3">
          <section className="card">
            <h2 className="border-b border-stone-200 px-4 py-3 text-sm font-semibold">Where they come from</h2>
            {data.sources.length ? (
              <ul className="p-2">
                {data.sources.slice(0, 12).map((s) => (
                  <li key={`${s.channel}:${s.source}`} className="flex items-center gap-3 rounded-md px-2.5 py-2">
                    <SourceIcon source={s.source} size={18} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{s.source}</span>
                      <span className="block text-xs text-stone-400">{s.channel === 'AI' ? 'AI assistant' : 'Search engine'}</span>
                    </span>
                    <span className="text-right">
                      <span className="num block text-sm font-semibold">{fmtNumber(s.visitors)}</span>
                      {s.revenue > 0 && <span className="num block text-xs text-stone-500">{money(s.revenue, true)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-10 text-center text-sm text-stone-400">No visitors from AI or search in these dates.</p>
            )}
          </section>

          {data.goals.length > 0 && (
            <section className="card">
              <div className="border-b border-stone-200 px-4 py-3">
                <h2 className="text-sm font-semibold">Goals</h2>
                <p className="mt-0.5 text-xs text-stone-500">Share of visitors who completed each one.</p>
              </div>
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500">
                    <th className="px-4 py-2 font-medium">Goal</th>
                    <th className="w-[60px] px-2 py-2 text-right font-medium">All</th>
                    <th className="w-[60px] px-2 py-2 text-right font-medium">AI</th>
                    <th className="w-[68px] px-4 py-2 text-right font-medium">Search</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {data.goals.slice(0, 6).map((goal) => (
                    <tr key={goal.name}>
                      <td className="truncate px-4 py-2" title={goal.name}>
                        {goal.name}
                      </td>
                      <td className="num px-2 py-2 text-right text-stone-600">{rate(goal.all, data.totals.all.visitors)}</td>
                      <td className="num px-2 py-2 text-right font-medium">{rate(goal.ai, ai.visitors)}</td>
                      <td className="num px-4 py-2 text-right font-medium">{rate(goal.search, search.visitors)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="card">
            <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
              <h2 className="text-sm font-semibold">robots.txt and sitemap</h2>
              {check.data && (
                <button className="btn-ghost -my-1 text-xs" onClick={recheck} disabled={rechecking}>
                  {rechecking ? 'Checking…' : 'Check again'}
                </button>
              )}
            </div>
            {!check.data ? (
              <p className={`px-4 py-6 text-sm text-stone-400 ${check.loading ? 'animate-pulse' : ''}`}>
                {check.error ? `Couldn't check: ${check.error}` : `Reading ${data.site.domain}/robots.txt and sitemap…`}
              </p>
            ) : (
              <dl className="space-y-3 px-4 py-3.5 text-sm">
                <div>
                  <dt className="text-xs text-stone-500">robots.txt</dt>
                  <dd className="mt-0.5">
                    {!check.data.robots.found
                      ? check.data.robots.status === 404
                        ? 'None, so every crawler may read every page'
                        : `Couldn't read it${check.data.robots.status ? ` (${check.data.robots.status})` : ''}`
                      : check.data.robots.blocked.length
                        ? `Blocks ${[...new Set(check.data.robots.blocked.map((b) => b.product))].join(', ')}`
                        : 'Lets ChatGPT, Claude, Perplexity, Google and Bing in'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">Sitemap</dt>
                  <dd className="mt-0.5">
                    {!check.data.sitemap.found ? (
                      'None found'
                    ) : (
                      <>
                        {check.data.sitemap.atLeast ? 'About ' : ''}
                        {fmtNumber(check.data.sitemap.total)} pages
                        {check.data.sitemap.checked > 0 && check.data.sitemap.days > 0 && (
                          <span className="mt-1 block text-xs leading-relaxed text-stone-500">
                            Of {check.data.sitemap.checked < check.data.sitemap.total ? `a sample of ${fmtNumber(check.data.sitemap.checked)}` : 'them'}, read
                            in the last {check.data.sitemap.days} days by Google:{' '}
                            {rate(check.data.sitemap.checked - check.data.sitemap.notGoogle, check.data.sitemap.checked)}, by AI search:{' '}
                            {rate(check.data.sitemap.checked - check.data.sitemap.notAi, check.data.sitemap.checked)}
                            {check.data.sitemap.days < 14 ? '. Crawlers revisit most pages over a few weeks, so this fills in with time.' : ''}
                          </span>
                        )}
                      </>
                    )}
                  </dd>
                </div>
                <p className="text-xs text-stone-400">
                  Checked {new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }).format(check.data.checked_at)}
                </p>
              </dl>
            )}
          </section>
        </div>
      </div>

      {!noTraffic && (
        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
            <h2 className="text-sm font-semibold">Visitors from AI and search</h2>
            <div className="flex items-center gap-4 text-sm text-stone-500">
              <span className="flex items-center gap-2">
                <span className="h-0.5 w-4 rounded-full" style={{ background: lines.ai }} /> AI assistants
              </span>
              <span className="flex items-center gap-2">
                <span className="h-0.5 w-4 rounded-full" style={{ background: lines.search }} /> Search engines
              </span>
            </div>
          </div>
          <div className="h-[260px] px-1 pb-2 pt-4 sm:px-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.series} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={color.grid} />
                <XAxis
                  dataKey="bucket"
                  tickFormatter={(b) => bucketLabel(b, g)}
                  tick={{ fill: color.axis, fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={28}
                />
                <YAxis tick={{ fill: color.axis, fontSize: 12 }} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
                <Tooltip
                  cursor={{ stroke: color.axis, strokeDasharray: '3 3' }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0].payload as {
                      ai: number;
                      search: number;
                    };
                    return (
                      <div className="pop min-w-[190px] px-3.5 py-3 text-sm">
                        <div className="mb-1.5 font-medium">{bucketLabel(String(label), g, true)}</div>
                        {(
                          [
                            ['AI assistants', row.ai, lines.ai],
                            ['Search engines', row.search, lines.search],
                          ] as const
                        ).map(([name, n, c]) => (
                          <div key={name} className="flex items-center justify-between gap-6 py-0.5">
                            <span className="flex items-center gap-2 text-stone-500">
                              <span className="h-2 w-2 rounded-full" style={{ background: c }} />
                              {name}
                            </span>
                            <span className="num font-medium">{fmtNumber(n)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  }}
                />
                <Line type="monotone" dataKey="ai" name="AI assistants" stroke={lines.ai} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="search" name="Search engines" stroke={lines.search} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {data.pages.length > 0 && (
        <section className="card overflow-hidden">
          <div className="border-b border-stone-200 px-4 py-3">
            <h2 className="text-sm font-semibold">Pages</h2>
            <p className="mt-0.5 text-xs text-stone-500">
              Read by AI: times an assistant opened the page to answer someone. The other columns are visitors who landed on it.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] table-fixed text-sm">
              <thead>
                <tr className="text-left text-xs text-stone-500">
                  <th className="px-4 py-2 font-medium">Page</th>
                  <th className="w-24 px-3 py-2 text-right font-medium">Read by AI</th>
                  <th className="w-24 px-3 py-2 text-right font-medium">From AI</th>
                  <th className="w-28 px-3 py-2 text-right font-medium">From search</th>
                  <th className="w-28 px-4 py-2 text-right font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {pages.map((p) => (
                  <tr key={p.path}>
                    <td className="px-4 py-2">
                      <a className="block truncate hover:underline" href={pageUrl(p.path)} target="_blank" rel="noreferrer" title={p.path}>
                        {p.path}
                      </a>
                    </td>
                    <td className="num px-3 py-2 text-right text-stone-600">{p.fetches ? fmtNumber(p.fetches) : '–'}</td>
                    <td className="num px-3 py-2 text-right font-medium">{p.ai_visitors ? fmtNumber(p.ai_visitors) : '–'}</td>
                    <td className="num px-3 py-2 text-right font-medium">{p.search_visitors ? fmtNumber(p.search_visitors) : '–'}</td>
                    <td className="num px-4 py-2 text-right">{p.revenue ? money(p.revenue) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.pages.length > 12 && (
            <button className="btn-ghost m-2 text-xs" onClick={() => setAllPages((v) => !v)}>
              {allPages ? 'Show fewer' : `Show all ${data.pages.length}`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
