import { NotFound } from '../App';
import type { Site } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Dashboard } from './Dashboard';
import { Sites } from './Sites';

/**
 * What a logged-out visitor sees: a card per public website at `/`, and that site's read-only dashboard
 * at `/site/:id`. A private (or unknown) site is just "not found", so a visitor can't even tell it exists.
 */
export function PublicEntry({ siteId }: { siteId?: string }) {
  const { data: sites, error } = useApi<Site[]>('/api/public/sites');
  if (!sites && !error) return null;
  if (!siteId) return <Sites readOnly />;
  if (!sites?.some((s) => s.id === siteId)) return <NotFound />;
  return <Dashboard siteId={siteId} readOnly />;
}
