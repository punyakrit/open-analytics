import { useCallback, useEffect, useMemo, useState } from 'react';
import { navigate } from '../App';
import { CrawlersPanel } from '../components/CrawlersPanel';
import { GoalsPanel } from '../components/GoalsPanel';
import { OverviewCard } from '../components/OverviewCard';
import { Panel, renderLabel } from '../components/Panel';
import { Toolbar } from '../components/Toolbar';
import { CloseIcon, GlobeIcon } from '../components/Icons';
import { VisitorModal } from '../components/VisitorModal';
import { qs, type Overview, type Site } from '../lib/api';
import { DashContext, type Dash } from '../lib/context';
import { fmtMoney } from '../lib/format';
import { useApi } from '../lib/useApi';
import { useQueryState } from '../lib/useQueryState';

const FILTER_LABELS: Record<string, { label: string; dim: string }> = {
  channel: { label: 'Channel', dim: 'channel' },
  source: { label: 'Referrer', dim: 'source' },
  utm_campaign: { label: 'Campaign', dim: 'campaign' },
  utm_term: { label: 'Keyword', dim: 'keyword' },
  utm_source: { label: 'UTM source', dim: 'utm_source' },
  utm_medium: { label: 'UTM medium', dim: 'utm_medium' },
  ref: { label: 'Ref', dim: 'ref' },
  country: { label: 'Country', dim: 'country' },
  region: { label: 'Region', dim: 'region' },
  city: { label: 'City', dim: 'city' },
  browser: { label: 'Browser', dim: 'browser' },
  os: { label: 'OS', dim: 'os' },
  device: { label: 'Device', dim: 'device' },
  page: { label: 'Visited page', dim: 'page' },
  entry_page: { label: 'Entry page', dim: 'entry_page' },
  hostname: { label: 'Hostname', dim: 'hostname' },
  goal: { label: 'Completed goal', dim: 'goal' },
};

/** The round globe button floating at the bottom of the dashboard: opens the real-time map. */
function MapButton({ online, onOpen }: { online: number; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      aria-label={`Open the real-time map, ${online} online`}
      title="Real-time map (M)"
      className="fixed bottom-5 left-1/2 z-40 flex h-12 -translate-x-1/2 items-center gap-2.5 rounded-full bg-ink pl-3.5 pr-4 text-sm font-medium text-paper shadow-pop transition-transform hover:-translate-y-0.5"
    >
      <GlobeIcon size={20} />
      Live map
      {online > 0 && (
        <span className="num flex h-5 min-w-5 items-center justify-center rounded-full bg-live px-1.5 text-[11px] font-bold text-white">{online}</span>
      )}
    </button>
  );
}

export function Dashboard({ siteId, readOnly = false }: { siteId: string; readOnly?: boolean }) {
  const base = readOnly ? '/api/public/sites' : '/api/sites';
  const [q, update] = useQueryState(siteId);
  const [reloadKey, setReloadKey] = useState(0);
  const [visitor, setVisitor] = useState<string | null>(null);
  const openLive = useCallback(() => navigate(`/site/${siteId}/live`), [siteId]);

  // Keep the numbers current while the dashboard sits open: every minute, and straight away when you
  // come back to the tab. (It used to load once, so a tab opened before the day's first visit stayed at 0.)
  useEffect(() => {
    const refresh = () => document.visibilityState === 'visible' && setReloadKey((k) => k + 1);
    const t = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  // "M" opens the real-time map.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) openLive();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [openLive]);
  const { data: sites } = useApi<Site[]>(base);
  const site = sites?.find((s) => s.id === siteId);
  const { data: overview, loading } = useApi<Overview>(site ? `${base}/${siteId}/overview?${qs(q)}` : null, reloadKey);

  const addFilter = useCallback((key: string, value: string) => update({ filters: { ...q.filters, [key]: value } }), [q.filters, update]);
  const removeFilter = (key: string) => {
    const { [key]: _, ...rest } = q.filters;
    update({ filters: rest });
  };

  const dash: Dash | null = useMemo(() => {
    if (!site) return null;
    const decimals = overview?.decimals ?? 2;
    return {
      site,
      base,
      readOnly,
      q,
      reloadKey,
      decimals,
      money: (minor, compact) => fmtMoney(minor, site.currency, decimals, compact),
      addFilter,
      // Visitor timelines are owner-only.
      openVisitor: readOnly ? () => {} : setVisitor,
    };
  }, [site, base, readOnly, q, reloadKey, overview?.decimals, addFilter]);

  if (sites && !site) {
    return (
      <div className="p-10 text-center">
        Site not found.{' '}
        <button className="underline" onClick={() => navigate('/')}>
          Back to websites
        </button>
      </div>
    );
  }
  if (!dash || !site) return null;

  return (
    <DashContext.Provider value={dash}>
      <div className="mx-auto max-w-[1360px] px-4 pb-24 pt-4 sm:px-6 sm:pt-6">
        <Toolbar
          site={site}
          sites={sites!}
          q={q}
          update={update}
          overview={overview}
          onRefresh={() => setReloadKey((k) => k + 1)}
          onLive={openLive}
          loading={loading}
          readOnly={readOnly}
        />

        {Object.keys(q.filters).length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {Object.entries(q.filters).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-surface py-0.5 pl-3 pr-0.5 text-sm">
                <span className="text-stone-500">{FILTER_LABELS[k]?.label ?? k}</span>
                <span className="flex items-center gap-1.5 font-medium">{renderLabel(FILTER_LABELS[k]?.dim ?? k, { label: v || null })}</span>
                <button className="flex h-6 w-6 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-ink" onClick={() => removeFilter(k)} aria-label="Remove filter">
                  <CloseIcon size={13} />
                </button>
              </span>
            ))}
            <button className="btn-ghost text-xs" onClick={() => update({ filters: {} })}>
              Clear filters
            </button>
          </div>
        )}

        <div className="mt-5">
          <OverviewCard data={overview} />
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <Panel
            tabs={[
              { label: 'Channel', dim: 'channel', filter: 'channel' },
              { label: 'Referrer', dim: 'source', filter: 'source' },
              { label: 'Campaign', dim: 'campaign', filter: 'utm_campaign' },
              { label: 'Keyword', dim: 'keyword', filter: 'utm_term' },
            ]}
          />
          <Panel
            tabs={[
              { label: 'Country', dim: 'country', filter: 'country' },
              { label: 'Region', dim: 'region', filter: 'region' },
              { label: 'City', dim: 'city', filter: 'city' },
            ]}
          />
          <Panel
            tabs={[
              { label: 'Page', dim: 'page', filter: 'page' },
              { label: 'Entry page', dim: 'entry_page', filter: 'entry_page' },
              { label: 'Exit link', dim: 'exit_link' },
              { label: 'Hostname', dim: 'hostname', filter: 'hostname' },
            ]}
          />
          <Panel
            tabs={[
              { label: 'Browser', dim: 'browser', filter: 'browser' },
              { label: 'OS', dim: 'os', filter: 'os' },
              { label: 'Device', dim: 'device', filter: 'device' },
            ]}
          />
        </div>

        <div className="mt-3">
          <GoalsPanel totalVisitors={overview?.current.visitors ?? 0} />
        </div>

        <div className="mt-3">
          <CrawlersPanel />
        </div>

        <p className="mt-8 text-center text-xs leading-relaxed text-stone-400">
          {overview?.imported && (
            <>
              Includes {overview.imported.origin === 'datafast' ? 'DataFast' : overview.imported.origin} history from {overview.imported.from} to {overview.imported.to} as
              daily totals{Object.keys(q.filters).length > 0 ? ', left out while filtering' : ''}.{' '}
            </>
          )}
          Days follow {site.timezone}. Revenue is in {site.currency}.
        </p>
      </div>
      <MapButton online={overview?.online ?? 0} onOpen={openLive} />
      {!readOnly && <VisitorModal key={visitor ?? 'none'} visitorId={visitor} onClose={() => setVisitor(null)} />}
    </DashContext.Provider>
  );
}
