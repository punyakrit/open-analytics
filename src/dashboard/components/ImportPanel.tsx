import { useEffect, useState } from 'react';
import { currencyDecimals } from '../../shared/currency';
import { api, ApiError, type Site } from '../lib/api';
import { fmtMoney, fmtNumber } from '../lib/format';

interface ImportStatus {
  status: 'running' | 'done' | 'error';
  phase: 'daily' | 'hourly' | 'breakdowns' | 'finish';
  total_days: number;
  done_days: number;
  first_day: string | null;
  last_day: string | null;
  visitors: number;
  revenue: number;
  message: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

/** A page step does about a day of history in ~13 seconds. */
const minutesLeft = (days: number) => {
  const m = Math.max(1, Math.ceil((days * 13) / 60));
  return `About ${m} minute${m === 1 ? '' : 's'}`;
};

const fmtDay = (day: string | null) => (day ? new Date(day + 'T00:00:00Z').toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

/**
 * Settings → Import data: paste a DataFast API key and the site's history comes over in the background.
 * While this page is open it asks the server for the next step as soon as one finishes; when it's closed,
 * the server's minute-by-minute job carries on by itself.
 */
export function ImportPanel({ site }: { site: Site }) {
  const [job, setJob] = useState<ImportStatus | null | undefined>(undefined);
  const [key, setKey] = useState('');
  const [sourceSite, setSourceSite] = useState('');
  const [unit, setUnit] = useState<'major' | 'minor'>('major');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const money = (minor: number) => fmtMoney(minor, site.currency, currencyDecimals(site.currency));

  useEffect(() => {
    api<{ import: ImportStatus | null }>(`/api/sites/${site.id}/import`).then((r) => setJob(r.import), () => setJob(null));
  }, [site.id]);

  // While the import runs and this page is open, keep asking for the next step.
  const running = job?.status === 'running';
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    (async () => {
      let last = '';
      while (!stopped) {
        let pause = 300;
        try {
          const r = await api<{ import: ImportStatus | null }>(`/api/sites/${site.id}/import/step`, { method: 'POST' });
          if (stopped) return;
          setJob(r.import);
          if (r.import?.status !== 'running') return;
          // No progress means the background job is mid-step: check back in a few seconds instead of right away.
          const now = `${r.import.phase}:${r.import.done_days}:${r.import.message}`;
          if (now === last) pause = 3_000;
          last = now;
        } catch {
          pause = 5_000;
        }
        await new Promise((res) => setTimeout(res, pause));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [running, site.id]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api<{ import: ImportStatus }>(`/api/sites/${site.id}/import`, { method: 'POST', json: { apiKey: key, sourceSite, revenueUnit: unit } });
      setKey('');
      setJob(r.import);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    await api(`/api/sites/${site.id}/import`, { method: 'DELETE' });
    setJob(null);
  }

  if (job === undefined) return <div className="h-40 animate-pulse rounded-lg bg-stone-200/50" />;

  const percent = !job
    ? 0
    : job.status !== 'running'
      ? 100
      : job.phase === 'daily'
        ? 3
        : job.phase === 'hourly'
          ? 8
          : 12 + Math.round((88 * job.done_days) / Math.max(1, job.total_days));
  const daysLeft = job ? Math.max(0, job.total_days - job.done_days) : 0;

  return (
    <section>
      <h3 className="text-[17px] font-semibold tracking-tight">Import from DataFast</h3>
      <p className="mt-1 text-sm leading-relaxed text-stone-500">
        Bring {site.name}'s DataFast history into this dashboard: daily visitors and revenue, hourly charts, sources, campaigns, pages, places, devices
        and goals. Days this dashboard already has its own data for are skipped, so nothing is counted twice.
      </p>

      {job && (
        <div
          className={`mt-5 rounded-lg border px-4 py-4 ${
            job.status === 'error' ? 'border-red-200 bg-red-50' : job.status === 'done' ? 'border-emerald-200 bg-emerald-50' : 'border-stone-200 bg-surface'
          }`}
          aria-live="polite"
        >
          {job.status === 'running' && (
            <>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">{job.message ?? 'Importing'}</span>
                <span className="num text-stone-500">{percent}%</span>
              </div>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-stone-100">
                <div className="h-full rounded-full bg-visitors transition-all duration-500" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-stone-500">
                {job.first_day && <>DataFast history from {fmtDay(job.first_day)} to {fmtDay(job.last_day)}. </>}
                {job.phase === 'breakdowns' && daysLeft > 0 && <>{minutesLeft(daysLeft)} left with this page open. </>}
                You can close this page: the import keeps going in the background, a little slower.
              </p>
              <button className="btn-ghost -ml-2 mt-2 text-red-600" onClick={stop}>
                Stop import
              </button>
            </>
          )}
          {job.status === 'done' && (
            <p className="text-sm text-emerald-800">
              <span className="font-medium">{job.message}.</span>
              {job.first_day && (
                <>
                  {' '}
                  The history now covers {fmtDay(job.first_day)} to {fmtDay(job.last_day)}: {fmtNumber(job.visitors)} visitor-days and {money(job.revenue)} revenue.
                  Pick "All time" on the dashboard to see it.
                </>
              )}
            </p>
          )}
          {job.status === 'error' && (
            <p className="text-sm text-red-600">
              <span className="font-medium">The import stopped.</span> {job.error}
              {job.done_days > 0 && ` The ${job.done_days} days imported before that are kept; starting again picks up from there.`}
            </p>
          )}
        </div>
      )}

      {!running && (
        <form onSubmit={start} className="mt-5 space-y-4">
          <div>
            <label className="label" htmlFor="df-key">
              DataFast API key
            </label>
            <input
              id="df-key"
              className="input font-mono"
              type="password"
              autoComplete="off"
              placeholder="df_..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <p className="hint">
              In DataFast, open the website, then Settings → API. The key is stored encrypted while the import runs and deleted when it ends.
            </p>
          </div>
          <details className="rounded-lg border border-stone-200 bg-surface px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-stone-700">More options</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="df-unit">
                  Revenue in DataFast's API
                </label>
                <select id="df-unit" className="input" value={unit} onChange={(e) => setUnit(e.target.value as 'major' | 'minor')}>
                  <option value="major">In {site.currency} (29.99)</option>
                  <option value="minor">In cents (2999)</option>
                </select>
                <p className="hint">If imported revenue looks 100 times off, import again with the other choice.</p>
              </div>
              <div>
                <label className="label" htmlFor="df-site">
                  DataFast website id
                </label>
                <input id="df-site" className="input" value={sourceSite} onChange={(e) => setSourceSite(e.target.value)} placeholder="Only for keys starting dft_" />
              </div>
            </div>
          </details>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          <button className="btn-dark" disabled={!key.trim() || busy}>
            {busy ? 'Checking the key…' : job?.status === 'done' ? 'Import again' : 'Start import'}
          </button>
          {job?.status === 'done' && <p className="hint">Importing again only fills in days that are missing.</p>}
        </form>
      )}
    </section>
  );
}
