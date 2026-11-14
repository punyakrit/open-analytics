import { Area, Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Kpis, Overview } from '../lib/api';
import { useDash } from '../lib/context';
import { bucketLabel, fmtDuration, fmtNumber, fmtPct } from '../lib/format';
import { usePref } from '../lib/prefs';
import { useChartColors } from '../lib/theme';

type Metric = 'visitors' | 'revenue';

function Change({ cur, prev, invert = false }: { cur: number; prev: number; invert?: boolean }) {
  if (!prev) return <span className="text-xs text-stone-400">No earlier data</span>;
  const pct = (cur - prev) / prev;
  if (!Number.isFinite(pct)) return null;
  const up = pct >= 0;
  const good = invert ? !up : up;
  const n = Math.abs(Math.round(pct * 100));
  return (
    <span className={`num text-xs font-medium ${n === 0 ? 'text-stone-400' : good ? 'text-emerald-600' : 'text-red-500'}`} title="Compared with the period before">
      {n === 0 ? 'Same as before' : `${up ? '+' : '−'}${n}% vs before`}
    </span>
  );
}

/** The numbers across the top, then the chart. Clicking Visitors or Revenue shows or hides it on the chart. */
export function OverviewCard({ data }: { data: Overview | null; onLive?: () => void }) {
  const { money } = useDash();
  const color = useChartColors();
  const [hidden, setHidden] = usePref<Record<Metric, boolean>>('ml_chart_hidden', { visitors: false, revenue: false });
  const c = data?.current;
  const p = data?.previous;

  const kpis: { key: keyof Kpis; label: string; value: string; invert?: boolean; metric?: Metric }[] = c
    ? [
        { key: 'visitors', label: 'Visitors', value: fmtNumber(c.visitors), metric: 'visitors' },
        { key: 'revenue', label: 'Revenue', value: money(c.revenue, true), metric: 'revenue' },
        { key: 'conversionRate', label: 'Conversion', value: fmtPct(c.conversionRate, c.conversionRate >= 0.1 ? 0 : 2) },
        { key: 'revenuePerVisitor', label: 'Per visitor', value: money(c.revenuePerVisitor) },
        { key: 'bounceRate', label: 'Bounce rate', value: fmtPct(c.bounceRate), invert: true },
        { key: 'avgDuration', label: 'Time on site', value: fmtDuration(c.avgDuration) },
      ]
    : [];

  const g = data?.range.granularity ?? 'day';

  return (
    <div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-stone-200 bg-stone-200 sm:grid-cols-3 lg:grid-cols-6">
        {kpis.map((k) => {
          const toggle = !!k.metric;
          const off = toggle && hidden[k.metric!];
          const Tag = toggle ? 'button' : 'div';
          return (
            <Tag
              key={k.key}
              className={`bg-surface px-4 py-3.5 text-left sm:px-5 ${toggle ? 'transition-colors hover:bg-stone-50' : ''}`}
              {...(toggle
                ? {
                    onClick: () => setHidden((h) => ({ ...h, [k.metric!]: !h[k.metric!] })),
                    'aria-pressed': !off,
                    title: off ? 'Show on the chart' : 'Hide from the chart',
                  }
                : {})}
            >
              <div className="flex items-center gap-2 text-[13px] text-stone-500">
                {toggle && (
                  <span
                    className={`h-2 w-2 rounded-full ${k.metric === 'visitors' ? 'bg-visitors' : 'bg-revenue'} ${off ? 'opacity-25' : ''}`}
                    aria-hidden="true"
                  />
                )}
                {k.label}
              </div>
              <div className={`num mt-1 text-[30px] font-semibold leading-none tracking-tight ${off ? 'text-stone-400' : ''}`}>{k.value}</div>
              <div className="mt-2 h-4">
                <Change cur={c![k.key]} prev={p![k.key]} invert={k.invert} />
              </div>
            </Tag>
          );
        })}
        {!data && <div className="col-span-full h-[106px] animate-pulse bg-surface" />}
      </div>

      <div className="card mt-3 h-[320px] px-1 pb-2 pt-5 sm:px-3">
        {data && (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data.series} margin={{ top: 5, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`vis-${color.theme}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color.visitors} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={color.visitors} stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={color.grid} />
              <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(b, g)} tick={{ fill: color.axis, fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={28} />
              <YAxis
                yAxisId="v"
                tick={{ fill: color.axis, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={44}
                allowDecimals={false}
                tickFormatter={(v) => fmtNumber(v)}
                hide={hidden.visitors}
              />
              <YAxis
                yAxisId="r"
                orientation="right"
                tick={{ fill: color.axis, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={56}
                tickFormatter={(v) => money(v, true)}
                hide={hidden.revenue}
                // Headroom keeps revenue bars in the lower part of the chart, under the visitors line.
                domain={[0, (max: number) => Math.max(1, Math.ceil(max * 1.6))]}
              />
              <Tooltip
                cursor={{ fill: color.cursor, opacity: 0.6 }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as Overview['series'][0];
                  return (
                    <div className="pop min-w-[190px] px-3.5 py-3 text-sm">
                      <div className="mb-2 font-medium">{bucketLabel(d.bucket, g, true)}</div>
                      <Row color="bg-visitors" label="Visitors" value={fmtNumber(d.visitors)} />
                      <Row color="bg-stone-300" label="Pageviews" value={fmtNumber(d.pageviews)} />
                      <Row color="bg-revenue" label="Revenue" value={money(d.revenue)} />
                      {d.payments > 0 && <Row color="bg-revenueSoft" label="Payments" value={String(d.payments)} />}
                    </div>
                  );
                }}
              />
              {!hidden.revenue && <Bar yAxisId="r" dataKey="revenue" fill={color.revenue} radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />}
              {!hidden.visitors && (
                <Area
                  yAxisId="v"
                  type="monotone"
                  dataKey="visitors"
                  stroke={color.visitors}
                  strokeWidth={2}
                  fill={`url(#vis-${color.theme})`}
                  dot={false}
                  activeDot={{ r: 4, fill: color.visitors, stroke: color.surface, strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function Row({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 py-0.5">
      <span className="flex items-center gap-2 text-stone-500">
        <span className={`h-2 w-2 rounded-full ${color}`} />
        {label}
      </span>
      <span className="num font-medium">{value}</span>
    </div>
  );
}
