import { useMemo, useState, type ReactNode } from 'react';
import { usePref } from '../lib/prefs';
import { qs, type BreakdownRow } from '../lib/api';
import { useDash } from '../lib/context';
import { countryName, fmtNumber, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';
import { BrowserIcon, ChannelIcon, DeviceIcon, Favicon, Flag, OSIcon, SourceIcon } from './Icons';
import { Modal } from './Modal';

export interface TabDef {
  label: string;
  dim: string;
  /** Session filter applied when a row is clicked (omit for non-filterable tabs). */
  filter?: string;
}

/** How each dimension's label and icon are shown. */
export function renderLabel(dim: string, row: Pick<BreakdownRow, 'label' | 'extra'>): ReactNode {
  const l = row.label;
  const text = (s: ReactNode) => <span className="truncate">{s}</span>;
  switch (dim) {
    case 'channel':
      return (
        <>
          <ChannelIcon channel={l} />
          {text(l)}
        </>
      );
    case 'source':
      return (
        <>
          <SourceIcon source={l} domain={row.extra} />
          {text(l ?? 'Direct/None')}
        </>
      );
    case 'country':
      return (
        <>
          <Flag cc={l} />
          {text(countryName(l))}
        </>
      );
    case 'region':
    case 'city':
      return (
        <>
          <Flag cc={row.extra ?? null} />
          {text(l ?? 'Unknown')}
        </>
      );
    case 'browser':
      return (
        <>
          <BrowserIcon name={l} />
          {text(l)}
        </>
      );
    case 'os':
      return (
        <>
          <OSIcon name={l} />
          {text(l)}
        </>
      );
    case 'device':
      return (
        <>
          <DeviceIcon name={l} />
          {text(l)}
        </>
      );
    case 'hostname':
      return (
        <>
          <Favicon domain={l} />
          {text(l)}
        </>
      );
    case 'exit_link': {
      let host: string | null = null;
      try {
        host = l ? new URL(l).hostname : null;
      } catch {}
      return (
        <>
          <Favicon domain={host} />
          {text(l?.replace(/^https?:\/\/(www\.)?/, ''))}
        </>
      );
    }
    default:
      return text(l ?? <span className="text-stone-400">(none)</span>);
  }
}

function Bars({ rows, dim, tab, sort, limit, onPick }: { rows: BreakdownRow[]; dim: string; tab: TabDef; sort: 'visitors' | 'revenue'; limit?: number; onPick?: (r: BreakdownRow) => void }) {
  const { money } = useDash();
  const sorted = useMemo(() => [...rows].sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0) || b.visitors - a.visitors), [rows, sort]);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  const maxV = Math.max(1, ...rows.map((r) => r.visitors));
  const maxR = Math.max(1, ...rows.map((r) => r.revenue));
  const hasRevenue = rows.some((r) => r.revenue > 0);

  return (
    <div className="space-y-0.5">
      {shown.map((r, i) => {
        const vw = (r.visitors / maxV) * (hasRevenue ? 62 : 100);
        const rw = hasRevenue ? (Math.max(0, r.revenue) / maxR) * 38 : 0;
        return (
          <div
            key={`${r.label}-${i}`}
            className={`group relative flex h-9 items-center rounded-md ${tab.filter ? 'cursor-pointer' : ''}`}
            onClick={() => onPick?.(r)}
          >
            <div className="absolute inset-0 flex">
              <div className="rounded-l-md bg-visitorsSoft" style={{ width: `${vw}%`, minWidth: r.visitors ? 3 : 0 }} />
              {rw > 0 && <div className="rounded-r-md bg-revenueSoft" style={{ width: `${rw}%` }} />}
            </div>
            <div className="absolute inset-0 hidden rounded-md ring-1 ring-stone-300 group-hover:block" />
            <div className="relative flex min-w-0 flex-1 items-center gap-2.5 px-2.5 text-sm">{renderLabel(dim, r)}</div>
            <div className="relative flex shrink-0 items-center gap-3 pr-2.5 text-sm font-medium">
              {r.revenue !== 0 && sort !== 'revenue' && <span className="num hidden font-normal text-stone-500 group-hover:inline">{money(r.revenue)}</span>}
              <span className="num">{sort === 'revenue' ? money(r.revenue, true) : fmtNumber(r.visitors)}</span>
            </div>
            <div className="pop pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden w-60 -translate-x-1/2 px-3 py-2.5 text-xs group-hover:block">
              <div className="mb-1.5 truncate font-medium">{r.label ?? '(none)'}</div>
              <Tip label="Visitors" value={fmtNumber(r.visitors)} />
              {r.pageviews !== undefined && dim === 'page' && <Tip label="Pageviews" value={fmtNumber(r.pageviews)} />}
              <Tip label="Revenue" value={money(r.revenue)} />
              <Tip label="Customers" value={String(r.customers)} />
              <Tip label="Conversion" value={r.visitors ? fmtPct(r.customers / r.visitors, 1) : '—'} />
              {tab.filter && <div className="mt-1.5 text-stone-400">Click to filter by this</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const Tip = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between py-px">
    <span className="text-stone-500">{label}</span>
    <span className="num">{value}</span>
  </div>
);

export function Panel({ tabs }: { tabs: TabDef[] }) {
  const { site, base, q, reloadKey, addFilter, money } = useDash();
  const [saved, setActive] = usePref(`ml_tab_${tabs[0].dim}`, tabs[0].dim);
  const active = tabs.some((t) => t.dim === saved) ? saved : tabs[0].dim;
  const [sort, setSort] = usePref<'visitors' | 'revenue'>(`ml_sort_${tabs[0].dim}`, 'visitors');
  const [details, setDetails] = useState(false);
  const [search, setSearch] = useState('');
  const tab = tabs.find((t) => t.dim === active)!;
  const { data, loading, error } = useApi<BreakdownRow[]>(`${base}/${site.id}/breakdown?${qs(q, { dim: active })}`, reloadKey);

  const pick = (r: BreakdownRow) => {
    if (!tab.filter) return;
    setDetails(false);
    addFilter(tab.filter, r.label ?? '');
  };

  const filtered = (data ?? []).filter((r) => !search || (r.label ?? '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="card flex min-h-[500px] flex-col">
      <div className="flex items-end justify-between gap-2 border-b border-stone-200 px-3">
        <div className="-mb-px flex overflow-x-auto" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.dim}
              role="tab"
              aria-selected={t.dim === active}
              className={`whitespace-nowrap border-b-2 px-2.5 pb-2.5 pt-3 text-sm transition-colors ${
                t.dim === active ? 'border-ink font-medium text-ink' : 'border-transparent text-stone-500 hover:text-ink'
              }`}
              onClick={() => setActive(t.dim)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          className="mb-1.5 flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-stone-500 hover:bg-stone-100 hover:text-ink"
          onClick={() => setSort((s) => (s === 'visitors' ? 'revenue' : 'visitors'))}
          title="Sort by visitors or by revenue"
        >
          By {sort === 'visitors' ? 'visitors' : 'revenue'}
        </button>
      </div>
      <div className={`flex-1 p-2 ${loading && !data ? 'animate-pulse' : ''}`}>
        {error && <p className="p-3 text-sm text-red-600">{error}</p>}
        {data && data.length === 0 && <p className="px-3 py-10 text-center text-sm text-stone-400">Nothing yet for these dates.</p>}
        {data && <Bars rows={data} dim={active} tab={tab} sort={sort} limit={10} onPick={pick} />}
      </div>
      {data && data.length > 10 && (
        <button className="mx-auto mb-3 rounded-md px-3 py-1 text-xs font-medium text-stone-500 hover:bg-stone-100 hover:text-ink" onClick={() => setDetails(true)}>
          See all {data.length}
        </button>
      )}
      <Modal open={details} onClose={() => setDetails(false)} title={tab.label} width="max-w-3xl">
        <input className="input mb-4" placeholder={`Search ${tab.label.toLowerCase()}`} value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-stone-500">
                <th className="pb-2 font-normal">{tab.label}</th>
                <th className="pb-2 text-right font-normal">Visitors</th>
                <th className="pb-2 text-right font-normal">Revenue</th>
                <th className="pb-2 text-right font-normal">Conv.</th>
                <th className="pb-2 text-right font-normal">Rev/visitor</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={i} className={`border-t border-stone-100 ${tab.filter ? 'cursor-pointer hover:bg-stone-50' : ''}`} onClick={() => pick(r)}>
                  <td className="max-w-[320px] py-2"><div className="flex min-w-0 items-center gap-2">{renderLabel(active, r)}</div></td>
                  <td className="num py-2 text-right">{fmtNumber(r.visitors)}</td>
                  <td className="num py-2 text-right">{money(r.revenue)}</td>
                  <td className="num py-2 text-right">{r.visitors ? fmtPct(r.customers / r.visitors, 1) : '—'}</td>
                  <td className="num py-2 text-right">{r.visitors ? money(r.revenue / r.visitors) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
}
