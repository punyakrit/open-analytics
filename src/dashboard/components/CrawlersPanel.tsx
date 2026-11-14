import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CRAWL_KINDS, crawlerByAgent, type CrawlKind } from '../../shared/bots';
import { navigate } from '../App';
import { qs } from '../lib/api';
import { useDash } from '../lib/context';
import { bucketLabel, fmtNumber } from '../lib/format';
import { usePref } from '../lib/prefs';
import { useChartColors } from '../lib/theme';
import { useApi } from '../lib/useApi';
import { Favicon } from './Icons';

interface CrawlData {
  kind: CrawlKind;
  granularity: 'hour' | 'day' | 'week' | 'month';
  totals: Record<CrawlKind, number>;
  bots: { agent: string; n: number }[];
  series: ({ bucket: string } & Record<string, number | string>)[];
  pages: { path: string; n: number }[];
}

/** One colour per crawler line, readable on both themes; anything past these is grouped as "Others". */
const LINE_COLORS = ['#5b7cfa', '#e0a43a', '#2fb38f', '#e5677a', '#a07cf0'];
const OTHERS = '__others';

const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

/**
 * Search engines and AI crawlers reading the site, split into AI answers, indexing and training. Crawlers
 * don't run the tracking script, so most of this comes from the server snippet in Settings → AI crawlers.
 */
export function CrawlersPanel() {
  const { site, base, q, reloadKey, readOnly } = useDash();
  const color = useChartColors();
  const [kind, setKind] = usePref<CrawlKind>('ml_crawl_kind', 'answers');
  const [view, setView] = useState<'crawlers' | 'pages'>('crawlers');
  const [focus, setFocus] = useState<string | null>(null);
  const { data, loading } = useApi<CrawlData>(`${base}/${site.id}/crawls?${qs({ ...q, filters: {} }, { kind })}`, reloadKey);

  const top = (data?.bots ?? []).slice(0, LINE_COLORS.length);
  const rest = (data?.bots ?? []).slice(LINE_COLORS.length);
  const lines = [
    ...top.map((b, i) => ({ key: b.agent, color: LINE_COLORS[i] })),
    ...(rest.length ? [{ key: OTHERS, color: color.axis }] : []),
  ];
  // Every crawler gets a value in every bucket, 0 when it didn't come. Crawlers visit in bursts, and a bucket
  // left empty breaks the line: a lone visit between empty hours would draw nothing at all.
  const series = (data?.series ?? []).map((row) => ({
    bucket: row.bucket,
    ...Object.fromEntries(top.map((b) => [b.agent, Number(row[b.agent]) || 0])),
    [OTHERS]: rest.reduce((n, b) => n + (Number(row[b.agent]) || 0), 0),
  }));
  const shown = focus ? lines.filter((l) => l.key === focus) : lines;
  const total = data ? data.totals[kind] : 0;
  const empty = data && !data.totals.answers && !data.totals.indexing && !data.totals.training;
  const g = data?.granularity ?? 'day';

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-3 py-2.5">
        <div className="tabs" role="tablist" aria-label="Crawler type">
          {CRAWL_KINDS.map((k) => (
            <button
              key={k.kind}
              role="tab"
              aria-selected={kind === k.kind}
              title={k.about}
              className={`tab flex items-center gap-1.5 ${kind === k.kind ? 'tab-active' : ''}`}
              onClick={() => {
                setKind(k.kind);
                setFocus(null);
              }}
            >
              {k.label}
              <span className="num text-xs text-stone-400">{data ? compact(data.totals[k.kind]) : ''}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="tabs">
            {(['crawlers', 'pages'] as const).map((v) => (
              <button key={v} className={`tab ${view === v ? 'tab-active' : ''}`} onClick={() => setView(v)}>
                {v === 'crawlers' ? 'Crawlers' : 'Pages'}
              </button>
            ))}
          </div>
          {!readOnly && (
            <button className="btn-ghost text-xs" onClick={() => navigate(`/site/${site.id}/settings#crawlers`)}>
              Set up
            </button>
          )}
        </div>
      </div>

      {empty ? (
        <div className="flex flex-col items-center px-6 py-14 text-center">
          <p className="font-medium">No crawler visits in these dates</p>
          <p className="mt-1 max-w-md text-sm text-stone-500">
            AI assistants and search engines read pages without running JavaScript, so the tracking script can't see most of them.
            {readOnly ? '' : ' Add the short server snippet from Settings to count them.'}
          </p>
          {!readOnly && (
            <button className="btn mt-4" onClick={() => navigate(`/site/${site.id}/settings#crawlers`)}>
              Show me how
            </button>
          )}
        </div>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className={`h-[300px] px-1 pb-2 pt-4 sm:px-3 ${loading && !data ? 'animate-pulse' : ''}`}>
            {data && (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={color.grid} />
                  <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(b, g)} tick={{ fill: color.axis, fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={28} />
                  <YAxis tick={{ fill: color.axis, fontSize: 12 }} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
                  <Tooltip
                    cursor={{ stroke: color.axis, strokeDasharray: '3 3' }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const rows = shown.map((l) => ({ ...l, n: Number(payload[0].payload[l.key]) || 0 })).filter((r) => r.n > 0);
                      return (
                        <div className="pop min-w-[180px] px-3.5 py-3 text-sm">
                          <div className="mb-1.5 font-medium">{bucketLabel(String(label), g, true)}</div>
                          {rows.length ? (
                            rows.map((r) => (
                              <div key={r.key} className="flex items-center justify-between gap-6 py-0.5">
                                <span className="flex items-center gap-2 text-stone-500">
                                  <span className="h-2 w-2 rounded-full" style={{ background: r.color }} />
                                  {r.key === OTHERS ? 'Others' : crawlerByAgent(r.key)?.name ?? r.key}
                                </span>
                                <span className="num font-medium">{fmtNumber(r.n)}</span>
                              </div>
                            ))
                          ) : (
                            <div className="text-stone-500">No visits</div>
                          )}
                        </div>
                      );
                    }}
                  />
                  {shown.map((l) => (
                    <Line key={l.key} type="monotone" dataKey={l.key} stroke={l.color} strokeWidth={2} dot={false} isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="max-h-[300px] overflow-y-auto border-t border-stone-200 p-2 lg:border-l lg:border-t-0">
            {data && !total && <p className="px-3 py-8 text-center text-sm text-stone-400">None of this type in these dates.</p>}
            {data && view === 'crawlers' &&
              data.bots.map((b) => {
                const info = crawlerByAgent(b.agent);
                const line = lines.find((l) => l.key === b.agent);
                const active = focus === b.agent;
                return (
                  <button
                    key={b.agent}
                    onClick={() => setFocus(active ? null : b.agent)}
                    className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${active ? 'bg-stone-100' : 'hover:bg-stone-50'}`}
                    title={active ? 'Show all crawlers' : 'Show only this crawler on the chart'}
                  >
                    <span className="h-6 w-0.5 shrink-0 rounded-full" style={{ background: line?.color ?? color.axis }} />
                    <Favicon domain={info?.domain} size={18} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{info?.name ?? b.agent}</span>
                      <span className="block truncate font-mono text-[11px] text-stone-400">{b.agent}</span>
                    </span>
                    <span className="num text-sm font-semibold">{fmtNumber(b.n)}</span>
                  </button>
                );
              })}
            {data && view === 'pages' &&
              data.pages.map((p) => (
                <div key={p.path} className="relative flex items-center gap-3 rounded-md px-2.5 py-2">
                  <div className="absolute inset-y-1 left-0 rounded-md bg-visitorsSoft" style={{ width: `${(p.n / data.pages[0].n) * 100}%` }} />
                  <span className="relative min-w-0 flex-1 truncate text-sm">{p.path}</span>
                  <span className="num relative text-sm font-semibold">{fmtNumber(p.n)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}
