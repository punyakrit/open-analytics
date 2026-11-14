import { useEffect, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import type { Overview, Query, Site } from '../lib/api';
import { dayInTz } from '../lib/format';
import { ArrowLeftIcon, ChevronDownIcon, ChevronIcon, Favicon, GearIcon, RefreshIcon } from './Icons';
import { ThemeToggle } from './ThemeToggle';

export const PERIODS: { value: string; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '48h', label: 'Last 2 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];

const GRANULARITIES = [
  { value: 'hour', label: 'Hourly' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

type Granularity = (typeof GRANULARITIES)[number]['value'];

function granularitiesForSpan(span: number): Granularity[] {
  const hour = 3_600_000;
  const day = 24 * hour;
  if (span <= 2 * day + hour) return ['hour'];
  if (span <= 7 * day + hour) return ['hour', 'day'];
  if (span <= 31 * day + hour) return ['day', 'week'];
  if (span <= 120 * day + hour) return ['day', 'week', 'month'];
  if (span <= 400 * day + hour) return ['week', 'month'];
  return ['month'];
}

export function Dropdown({ button, children, align = 'left' }: { button: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', on);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', on);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="relative flex" ref={ref}>
      <div className="flex" onClick={() => setOpen((o) => !o)}>
        {button}
      </div>
      {open && (
        <div className={`oa-pop-in pop absolute top-full z-40 mt-1.5 min-w-[210px] overflow-hidden p-1 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function itemCls(active: boolean) {
  return `flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-stone-100 ${active ? 'font-medium text-ink' : 'text-stone-600'}`;
}

export function Toolbar({
  site,
  sites,
  q,
  update,
  overview,
  onRefresh,
  onLive,
  loading,
  readOnly = false,
}: {
  site: Site;
  sites: Site[];
  q: Query;
  update: (p: Partial<Query>) => void;
  overview: Overview | null;
  onRefresh: () => void;
  onLive: () => void;
  loading: boolean;
  readOnly?: boolean;
}) {
  const [from, setFrom] = useState(q.from ?? '');
  const [to, setTo] = useState(q.to ?? '');

  const label =
    q.period === 'custom'
      ? q.from === q.to
        ? new Date(q.from + 'T00:00:00Z').toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        : `${q.from} to ${q.to}`
      : PERIODS.find((p) => p.value === q.period)?.label ?? 'Last 30 days';

  function shift(dir: -1 | 1) {
    if (!overview) return;
    const { from, to } = overview.range;
    const span = Math.max(to - from, 86_400_000);
    const nf = from + dir * span;
    const nt = nf + span - 1;
    if (nf > Date.now()) return;
    update({ period: 'custom', from: dayInTz(nf, site.timezone), to: dayInTz(Math.min(nt, Date.now()), site.timezone) });
  }
  const canForward = overview ? overview.range.to < Date.now() - 60_000 : false;
  const allowedGranularities = granularitiesForSpan(overview ? overview.range.to - overview.range.from : 30 * 86_400_000);
  const requestedGranularity = q.granularity as Granularity | undefined;
  const currentGranularity = requestedGranularity && allowedGranularities.includes(requestedGranularity) ? requestedGranularity : overview?.range.granularity;
  const settings = () => navigate(`/site/${site.id}/settings`);
  const back = () => ((window.history.state as { app?: boolean } | null)?.app ? window.history.back() : navigate('/'));

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
      {/* Which site */}
      <div className="flex min-w-0 items-center gap-1">
        <button className="icon-btn -ml-2" onClick={back} aria-label="All websites" title="All websites">
          <ArrowLeftIcon />
        </button>
        <Dropdown
          button={
            <button className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1 transition-colors hover:bg-stone-100" aria-label="Switch website">
              <Favicon domain={site.domain} size={24} />
              <span className="max-w-[220px] truncate text-xl font-semibold tracking-tight">{site.name}</span>
              <ChevronDownIcon />
            </button>
          }
        >
          {(close) => (
            <>
              {sites.map((s) => (
                <button
                  key={s.id}
                  className={itemCls(s.id === site.id)}
                  onClick={() => {
                    close();
                    // Switching replaces the history entry, so Back returns to the websites list rather than
                    // stepping through every site viewed.
                    navigate(`/site/${s.id}${window.location.search}`, { replace: true });
                  }}
                >
                  <Favicon domain={s.domain} size={16} /> <span className="truncate">{s.name}</span>
                </button>
              ))}
              <div className="my-1 border-t border-stone-100" />
              <button className={itemCls(false)} onClick={() => navigate('/')}>
                All websites
              </button>
            </>
          )}
        </Dropdown>
      </div>

      {/* When */}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <div className="flex h-9 items-stretch rounded-lg border border-stone-200 bg-surface">
          <button className="flex w-8 items-center justify-center rounded-l-lg text-stone-500 hover:bg-stone-50 hover:text-ink" onClick={() => shift(-1)} aria-label="Previous period">
            <ChevronIcon dir="left" />
          </button>
          <Dropdown
            button={
              <button className="flex h-full items-center gap-2 border-x border-stone-200 px-3 text-sm font-medium hover:bg-stone-50">
                {label} <ChevronDownIcon />
              </button>
            }
          >
            {(close) => (
              <>
                {PERIODS.map((p) => (
                  <button
                    key={p.value}
                    className={itemCls(q.period === p.value)}
                    onClick={() => {
                      close();
                      update({ period: p.value, granularity: undefined });
                    }}
                  >
                    {p.label}
                  </button>
                ))}
                <div className="my-1 border-t border-stone-100" />
                <form
                  className="space-y-2 p-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!from || !to) return;
                    close();
                    update({ period: 'custom', from, to: to < from ? from : to, granularity: undefined });
                  }}
                >
                  <div className="text-xs text-stone-500">Pick dates</div>
                  <input type="date" aria-label="From" className="input py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} />
                  <input type="date" aria-label="To" className="input py-1.5" value={to} onChange={(e) => setTo(e.target.value)} />
                  <button className="btn-dark w-full">Show these dates</button>
                </form>
              </>
            )}
          </Dropdown>
          <button
            className="flex w-8 items-center justify-center rounded-r-lg text-stone-500 hover:bg-stone-50 hover:text-ink disabled:opacity-30"
            onClick={() => shift(1)}
            disabled={!canForward}
            aria-label="Next period"
          >
            <ChevronIcon dir="right" />
          </button>
        </div>

        <Dropdown
          align="right"
          button={
            <button className="btn h-9">
              {GRANULARITIES.find((g) => g.value === currentGranularity)?.label ?? 'Daily'} <ChevronDownIcon />
            </button>
          }
        >
          {(close) =>
            GRANULARITIES.filter((g) => allowedGranularities.includes(g.value)).map((g) => (
              <button
                key={g.value}
                className={itemCls(currentGranularity === g.value)}
                onClick={() => {
                  close();
                  update({ granularity: g.value });
                }}
              >
                {g.label}
              </button>
            ))
          }
        </Dropdown>

        <button className="btn h-9" onClick={onLive} title="Real-time map (M)">
          <span className="h-2 w-2 animate-pulse rounded-full bg-live" />
          <span className="num">{overview?.online ?? 0}</span> online
        </button>

        <div className="flex items-center">
          <button className="icon-btn" onClick={onRefresh} aria-label="Refresh" title="Refresh">
            <RefreshIcon size={17} spinning={loading} />
          </button>
          <ThemeToggle />
          {!readOnly && (
            <button className="icon-btn" onClick={settings} title="Settings" aria-label={`Settings for ${site.name}`}>
              <GearIcon size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
