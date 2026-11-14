import { lazy, Suspense } from 'react';
import { navigate, NotFound } from '../App';
import type { Site } from '../lib/api';
import { useApi } from '../lib/useApi';

// The map library is large, so it is only downloaded when this page opens.
const LiveView = lazy(() => import('../components/LiveView'));

const Space = () => <div className="fixed inset-0 bg-[#070b1d]" />;

/** /site/:id/live: the full-page real-time map. Public sites show it to anyone; private ones only to the owner. */
export function LivePage({ siteId, readOnly }: { siteId: string; readOnly: boolean }) {
  const base = readOnly ? '/api/public/sites' : '/api/sites';
  const { data: sites, error } = useApi<Site[]>(base);
  if (!sites && !error) return <Space />;
  const site = sites?.find((s) => s.id === siteId);
  if (!site) return <NotFound />;
  // Back to the dashboard it was opened from (keeping its date range), or to the site's dashboard.
  const close = () => (window.history.state?.app ? window.history.back() : navigate(`/site/${site.id}`));
  return (
    <Suspense fallback={<Space />}>
      <LiveView site={site} base={base} onClose={close} />
    </Suspense>
  );
}
