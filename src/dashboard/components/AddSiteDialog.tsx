import { useEffect, useState } from 'react';
import { navigate } from '../App';
import { api, type Site } from '../lib/api';
import { CodeBlock } from './CodeBlock';
import { CheckIcon } from './Icons';
import { Modal } from './Modal';
import { CurrencySelect, TimezoneSelect } from './SiteFields';

/** "https://www.Example.com/pricing" → "example.com" */
export function cleanDomain(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

/** "example.com" → "Example" */
function nameFor(domain: string) {
  const first = domain.split('.')[0] ?? '';
  return first ? first[0].toUpperCase() + first.slice(1) : '';
}

/**
 * Adding a website, in two steps: what it is, then the script to install. The second step watches for the
 * first visit, so you can tell straight away whether the script is working.
 */
export function AddSiteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [site, setSite] = useState<Site | null>(null);
  const close = () => {
    setSite(null);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} width="max-w-[520px]" bare>
      <div className="h-1 w-full overflow-hidden rounded-t-xl bg-stone-100">
        <div className={`h-full bg-visitors transition-all duration-300 ${site ? 'w-full' : 'w-1/2'}`} />
      </div>
      {site ? <Install site={site} onClose={close} /> : <Details onAdded={setSite} onCancel={close} />}
    </Modal>
  );
}

function Details({ onAdded, onCancel }: { onAdded: (s: Site) => void; onCancel: () => void }) {
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [currency, setCurrency] = useState('USD');
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const clean = cleanDomain(domain);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onAdded(await api<Site>('/api/sites', { method: 'POST', json: { domain: clean, name: name.trim() || nameFor(clean), timezone, currency } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="p-6">
      <h2 className="text-xl font-semibold tracking-tight">Add a website</h2>
      <p className="mt-1 text-sm text-stone-500">You'll get a one-line script to put on it next.</p>

      <div className="mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="add-domain">
            Domain
          </label>
          <input id="add-domain" className="input" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} autoFocus />
          <p className="hint">Visits to its subdomains, like app.{clean || 'example.com'}, count here too.</p>
        </div>
        <div>
          <label className="label" htmlFor="add-name">
            Name
          </label>
          <input id="add-name" className="input" placeholder={nameFor(clean) || 'My product'} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {more ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Timezone</label>
              <TimezoneSelect value={timezone} onChange={setTimezone} />
            </div>
            <div>
              <label className="label">Revenue currency</label>
              <CurrencySelect value={currency} onChange={setCurrency} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-stone-500">
            Days follow {timezone} and revenue is shown in {currency}.{' '}
            <button type="button" className="font-medium text-ink underline decoration-stone-300 underline-offset-2 hover:decoration-ink" onClick={() => setMore(true)}>
              Change
            </button>
          </p>
        )}
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="mt-7 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-dark" disabled={!clean.includes('.') || busy}>
          {busy ? 'Adding…' : 'Add website'}
        </button>
      </div>
    </form>
  );
}

function Install({ site, onClose }: { site: Site; onClose: () => void }) {
  const origin = window.location.origin;
  const [seen, setSeen] = useState(false);

  // Check for the first visit every few seconds until it arrives.
  useEffect(() => {
    if (seen) return;
    const t = setInterval(async () => {
      const sites = await api<Site[]>('/api/sites').catch(() => null);
      const s = sites?.find((x) => x.id === site.id);
      if (s && ((s.visitors24h ?? 0) > 0 || (s.online ?? 0) > 0)) setSeen(true);
    }, 3000);
    return () => clearInterval(t);
  }, [seen, site.id]);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <div className="p-6">
      <h2 className="text-xl font-semibold tracking-tight">Put this on {site.domain}</h2>
      <p className="mt-1 text-sm text-stone-500">
        Paste it inside the <code className="text-ink">&lt;head&gt;</code> of every page. It sets no third-party cookies, and visits from this
        browser aren't counted.
      </p>

      <div className="mt-5">
        <CodeBlock label="HTML">{`<script defer data-website-id="${site.id}" src="${origin}/js/script.js"></script>`}</CodeBlock>
      </div>

      <div className={`mt-4 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${seen ? 'bg-emerald-50 text-emerald-800' : 'bg-stone-50 text-stone-600'}`} aria-live="polite">
        {seen ? (
          <>
            <CheckIcon size={16} /> First visit received. {site.name} is being tracked.
          </>
        ) : (
          <>
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-visitors opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-visitors" />
            </span>
            Waiting for the first visit. Open {site.domain} in another tab once the script is live.
          </>
        )}
      </div>

      <div className="mt-7 flex flex-wrap items-center justify-between gap-2">
        <button className="btn-ghost -ml-2" onClick={() => go(`/site/${site.id}/settings`)}>
          Payments and goals
        </button>
        <button className="btn-dark" onClick={() => go(`/site/${site.id}`)}>
          Open dashboard
        </button>
      </div>
    </div>
  );
}
