import { useEffect, useState } from 'react';
import { Area, Bar, ComposedChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import { currencyDecimals } from '../../shared/currency';
import { navigate } from '../App';
import { AddSiteDialog } from '../components/AddSiteDialog';
import { Favicon, GearIcon, LogOutIcon, PlusIcon, RefreshIcon } from '../components/Icons';
import { Logo } from '../components/Logo';
import { ThemeToggle } from '../components/ThemeToggle';
import { api, type Site, type SiteSpark } from '../lib/api';
import { fmtMoney, fmtNumber } from '../lib/format';
import { usePref } from '../lib/prefs';
import { useChartColors } from '../lib/theme';
import { useApi } from '../lib/useApi';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIODS = [
  { value: '24h', label: '24 hours', phrase: 'In the last 24 hours', span: DAY },
  { value: '7d', label: '7 days', phrase: 'In the last 7 days', span: 7 * DAY },
  { value: '30d', label: '30 days', phrase: 'In the last 30 days', span: 30 * DAY },
  { value: '90d', label: '90 days', phrase: 'In the last 90 days', span: 90 * DAY },
];
type Period = (typeof PERIODS)[number];
const AUTO_REFRESH_MS = 60_000;

type Point = { visitors: number; revenue: number };
type Money = { currency: string; amount: number };
const moneyText = (list: Money[]) => list.map((r) => fmtMoney(r.amount, r.currency, currencyDecimals(r.currency), true)).join(' + ');

/**
 * The websites page. `readOnly` is what logged-out visitors see: the owner's public sites, each opening
 * that site's read-only dashboard, with no adding, settings or signing out.
 */
export function Sites({ readOnly = false }: { readOnly?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [periodValue, setPeriod] = usePref('ml_sites_period', '24h');
  const [reloadKey, setReloadKey] = useState(0);
  const base = readOnly ? '/api/public' : '/api';
  const { data: sites, loading: loadingSites } = useApi<Site[]>(`${base}/sites`, reloadKey);
  const { data: sparks, loading: loadingSparks } = useApi<SiteSpark[]>(`${base}/sites-overview?period=${periodValue}`, reloadKey);
  const loading = loadingSites || loadingSparks;
  const period = PERIODS.find((p) => p.value === periodValue) ?? PERIODS[0];

  useEffect(() => {
    if (!readOnly && sites && !sites.length) setAdding(true);
  }, [sites, readOnly]);

  // Keep the numbers fresh while the page sits open, and catch up as soon as you come back to the tab.
  useEffect(() => {
    const refresh = () => document.visibilityState === 'visible' && setReloadKey((k) => k + 1);
    const t = setInterval(refresh, AUTO_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    window.dispatchEvent(new Event('ml:logout'));
  }

  const bySite = new Map(sparks?.map((s) => [s.id, s]));
  const combined: Point[] | undefined = sparks?.[0]?.series.map((_, i) => ({
    visitors: sparks.reduce((n, s) => n + (s.series[i]?.visitors ?? 0), 0),
    revenue: sparks.reduce((n, s) => n + (s.series[i]?.revenue ?? 0), 0),
  }));
  // The overview chart's revenue axis only makes sense in one currency.
  const currencies = new Set(sites?.map((s) => s.currency));
  const oneCurrency = currencies.size === 1 ? [...currencies][0] : null;

  return (
    <div className="mx-auto max-w-[1120px] px-4 pb-24 sm:px-6">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          {!readOnly && (
            <>
              <button className="icon-btn" onClick={logout} aria-label="Sign out" title="Sign out">
                <LogOutIcon />
              </button>
              <button className="btn-dark ml-2" onClick={() => setAdding(true)}>
                <PlusIcon size={16} /> Add website
              </button>
            </>
          )}
        </div>
      </header>

      <section className="pb-8 pt-10 sm:pt-14">
        <Summary sites={sites} sparks={sparks} period={period} readOnly={readOnly} />
      </section>

      {sites && !sites.length ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center">
          <p className="font-medium">{readOnly ? 'Nothing is shared here yet.' : 'Add a website to start counting visits.'}</p>
          {!readOnly && (
            <>
              <p className="mt-1 text-sm text-stone-500">You'll get a one-line script to put on it.</p>
              <button className="btn-dark mt-5" onClick={() => setAdding(true)}>
                <PlusIcon size={16} /> Add your first website
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-1 pt-4">
              <div className="flex items-center gap-4 text-[13px] text-stone-500">
                <h2 className="text-[15px] font-semibold text-ink">{sites && sites.length > 1 ? 'All websites' : 'Overview'}</h2>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-visitors" /> Visitors
                </span>
                {oneCurrency && (
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm bg-revenue" /> Revenue
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <div className="tabs" role="tablist" aria-label="Period">
                  {PERIODS.map((p) => (
                    <button key={p.value} role="tab" aria-selected={period.value === p.value} className={`tab ${period.value === p.value ? 'tab-active' : ''}`} onClick={() => setPeriod(p.value)}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <button className="icon-btn" onClick={() => setReloadKey((k) => k + 1)} aria-label="Refresh" title="Refresh">
                  <RefreshIcon size={17} spinning={loading} />
                </button>
              </div>
            </div>
            <div className="h-[220px] px-2 pb-2 sm:h-[260px]">
              <OverviewChart series={combined} period={period} currency={oneCurrency} />
            </div>
          </section>

          <div className="mb-3 mt-10 flex items-baseline justify-between">
            <h2 className="text-[15px] font-semibold">Websites</h2>
            {sites && <span className="text-[13px] text-stone-500">{sites.length}</span>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {!sites && [0, 1, 2].map((i) => <div key={i} className="card h-[190px] animate-pulse" />)}
            {sites?.map((s) => (
              <SiteCard key={s.id} site={s} spark={bySite.get(s.id)} period={period} readOnly={readOnly} />
            ))}
          </div>
        </>
      )}
      {!readOnly && <AddSiteDialog open={adding} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** The opening line: the whole period in one sentence. */
function Summary({ sites, sparks, period, readOnly }: { sites: Site[] | null; sparks: SiteSpark[] | null; period: Period; readOnly: boolean }) {
  if (!sites || !sparks) {
    return (
      <div className="space-y-3" aria-hidden="true">
        <div className="h-9 w-3/4 animate-pulse rounded-lg bg-stone-200/60" />
        <div className="h-9 w-1/3 animate-pulse rounded-lg bg-stone-200/60" />
      </div>
    );
  }
  const currency = new Map(sites.map((s) => [s.id, s.currency]));
  const visitors = sparks.reduce((n, s) => n + s.visitors, 0);
  const online = sparks.reduce((n, s) => n + s.online, 0);
  const revenue = new Map<string, number>();
  for (const s of sparks) {
    const c = currency.get(s.id) ?? 'USD';
    revenue.set(c, (revenue.get(c) ?? 0) + s.revenue);
  }
  const paid = [...revenue].filter(([, amount]) => amount > 0).map(([c, amount]) => ({ currency: c, amount }));
  const where = sites.length === 1 ? sites[0].name : readOnly ? `${sites.length} websites` : `your ${sites.length} websites`;

  return (
    <h1 className="max-w-[30ch] text-[clamp(1.6rem,3.6vw,2.5rem)] font-medium leading-[1.18] tracking-[-0.025em] text-stone-400">
      {period.phrase}, <Strong>{fmtNumber(visitors)}</Strong> {visitors === 1 ? 'person' : 'people'} visited {where}
      {paid.length ? (
        <>
          {' '}
          and paid <Strong>{moneyText(paid)}</Strong>
        </>
      ) : null}
      .
      {online > 0 && (
        <>
          {' '}
          <Strong>{fmtNumber(online)}</Strong> {online === 1 ? 'is' : 'are'} here right now.
        </>
      )}
    </h1>
  );
}

const Strong = ({ children }: { children: string }) => <span className="num text-ink">{children}</span>;

/** When bucket i of a sparkline starts (the server splits the period into equal buckets ending now). */
function bucketTime(period: Period, n: number, i: number) {
  const start = Date.now() - period.span + (period.span / n) * i;
  return period.span <= DAY
    ? new Date(start).toLocaleTimeString('en', { hour: 'numeric' })
    : new Date(start).toLocaleDateString('en', { day: 'numeric', month: 'short' });
}

function OverviewChart({ series, period, currency }: { series?: Point[]; period: Period; currency: string | null }) {
  const c = useChartColors();
  if (!series) return <div className="mx-3 h-full animate-pulse rounded-lg bg-stone-100" />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={series} margin={{ top: 16, right: 8, bottom: 4, left: 8 }}>
        <defs>
          <linearGradient id={`all-${c.theme}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.visitors} stopOpacity={0.24} />
            <stop offset="100%" stopColor={c.visitors} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis yAxisId="v" hide domain={[0, (max: number) => Math.max(4, max * 1.1)]} />
        <YAxis yAxisId="r" hide domain={[0, (max: number) => Math.max(1, max * 2.2)]} />
        <Tooltip
          cursor={{ stroke: c.axis, strokeDasharray: '3 3' }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as Point;
            return (
              <div className="pop min-w-[160px] px-3 py-2.5 text-sm">
                <div className="mb-1 text-xs text-stone-500">{bucketTime(period, series.length, Number(label))}</div>
                <div className="flex justify-between gap-6">
                  <span className="text-stone-500">Visitors</span>
                  <span className="num font-medium">{fmtNumber(d.visitors)}</span>
                </div>
                {currency && (
                  <div className="flex justify-between gap-6">
                    <span className="text-stone-500">Revenue</span>
                    <span className="num font-medium">{fmtMoney(d.revenue, currency, currencyDecimals(currency), true)}</span>
                  </div>
                )}
              </div>
            );
          }}
        />
        {currency && <Bar yAxisId="r" dataKey="revenue" fill={c.revenue} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />}
        <Area
          yAxisId="v"
          type="monotone"
          dataKey="visitors"
          stroke={c.visitors}
          strokeWidth={2}
          fill={`url(#all-${c.theme})`}
          activeDot={{ r: 4, fill: c.visitors, stroke: c.surface, strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function SiteCard({ site, spark, period, readOnly }: { site: Site; spark?: SiteSpark; period: Period; readOnly: boolean }) {
  const quiet = !!spark && spark.visitors === 0 && spark.revenue === 0;
  return (
    <div className="card group relative flex flex-col overflow-hidden transition-colors hover:border-stone-300">
      <div className="flex items-start gap-3 px-4 pt-4">
        <Favicon domain={site.domain} size={28} />
        <button
          className="min-w-0 flex-1 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-visitors"
          onClick={() => navigate(`/site/${site.id}`)}
        >
          <span className="block truncate font-semibold leading-tight">{site.name}</span>
          <span className="block truncate text-[13px] text-stone-500">{site.domain}</span>
        </button>
        {!!spark?.online && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800" title="On the site right now">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
            {spark.online} now
          </span>
        )}
        {!readOnly && (
          <button
            onClick={() => navigate(`/site/${site.id}/settings`)}
            className="icon-btn relative z-10 -mr-1.5 -mt-1 h-8 w-8 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
            title="Settings"
            aria-label={`Settings for ${site.name}`}
          >
            <GearIcon size={16} />
          </button>
        )}
      </div>

      <div className="mt-4 flex gap-6 px-4">
        <div>
          <div className="num text-2xl font-semibold leading-none tracking-tight">{spark ? fmtNumber(spark.visitors) : '—'}</div>
          <div className="mt-1 text-xs text-stone-500">visitors</div>
        </div>
        <div>
          <div className={`num text-2xl font-semibold leading-none tracking-tight ${spark?.revenue ? '' : 'text-stone-400'}`}>
            {spark ? fmtMoney(spark.revenue, site.currency, currencyDecimals(site.currency), true) : '—'}
          </div>
          <div className="mt-1 text-xs text-stone-500">revenue</div>
        </div>
      </div>

      <div className="mt-auto h-16 pt-3">
        {quiet ? (
          <div className="flex h-full items-end px-4 pb-3 text-xs text-stone-400">No visits in the last {period.label}</div>
        ) : (
          <Sparkline series={spark?.series} />
        )}
      </div>
    </div>
  );
}

function Sparkline({ series }: { series?: Point[] }) {
  const c = useChartColors();
  if (!series) return <div className="mx-4 h-full animate-pulse rounded bg-stone-100" />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`spark-${c.theme}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.visitors} stopOpacity={0.2} />
            <stop offset="100%" stopColor={c.visitors} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis yAxisId="v" hide domain={[0, (max: number) => Math.max(2, max)]} />
        <YAxis yAxisId="r" hide domain={[0, (max: number) => Math.max(1, max * 1.6)]} />
        <Bar yAxisId="r" dataKey="revenue" fill={c.revenue} radius={[2, 2, 0, 0]} maxBarSize={6} isAnimationActive={false} />
        <Area yAxisId="v" type="monotone" dataKey="visitors" stroke={c.visitors} strokeWidth={1.6} fill={`url(#spark-${c.theme})`} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
