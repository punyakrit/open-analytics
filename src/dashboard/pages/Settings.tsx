import { useEffect, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import { CodeBlock, CopyButton, CopyField } from '../components/CodeBlock';
import { CloseIcon, Favicon } from '../components/Icons';
import { Modal } from '../components/Modal';
import { SecurityPanel } from '../components/SecurityPanel';
import { CurrencySelect, TimezoneSelect } from '../components/SiteFields';
import { buildAiPrompt } from '../lib/aiPrompt';
import { api, type Site } from '../lib/api';
import { fmtAgo, fmtMoney } from '../lib/format';

function Section({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10 last:mb-0">
      <h3 className="text-[17px] font-semibold tracking-tight">{title}</h3>
      {desc && <p className="mt-1 text-sm leading-relaxed text-stone-500">{desc}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const Code = ({ label, children }: { label?: string; children: string }) => <CodeBlock label={label}>{children}</CodeBlock>;

function SecretField({ value, configured, onChange, onSave }: { value: string; configured: boolean; onChange: (v: string) => void; onSave: () => void }) {
  return (
    <div>
      <div className="flex gap-2">
        <input className="input font-mono" type="password" placeholder="whsec_..." value={value} onChange={(e) => onChange(e.target.value)} />
        <button className="btn-dark" onClick={onSave}>
          Save
        </button>
      </div>
      {configured && <p className="mt-1.5 text-xs text-emerald-600">Connected</p>}
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="space-y-5 text-sm">{children}</ol>;
}

function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="num mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-stone-300 text-[11px] font-semibold text-stone-600">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <p>{title}</p>
        {children}
      </div>
    </li>
  );
}

type Tab = 'general' | 'install' | 'goals' | 'payments' | 'links' | 'sharing' | 'security' | 'delete';
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'install', label: 'Install' },
  { id: 'goals', label: 'Goals' },
  { id: 'payments', label: 'Payments' },
  { id: 'links', label: 'Campaign links' },
  { id: 'sharing', label: 'Sharing' },
  { id: 'security', label: 'Sign-in security' },
  { id: 'delete', label: 'Delete website' },
];
const isTab = (t: string): t is Tab => TABS.some((x) => x.id === t);

/**
 * A site's settings, in a panel that slides over its dashboard. One section at a time, picked from the list
 * on the left (along the top on phones). The section is kept in the URL's #hash so a reload stays on it.
 */
export function Settings({ siteId }: { siteId: string }) {
  const [site, setSite] = useState<Site | null>(null);
  const [form, setForm] = useState<Partial<Site>>({});
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [tab, setTabState] = useState<Tab>(() => {
    const h = window.location.hash.slice(1);
    return isTab(h) ? h : 'general';
  });
  const origin = window.location.origin;

  const setTab = (t: Tab) => {
    setTabState(t);
    window.history.replaceState(window.history.state, '', `#${t}`);
  };
  const close = () => ((window.history.state as { app?: boolean } | null)?.app ? window.history.back() : navigate(`/site/${siteId}`));

  useEffect(() => {
    api<Site>(`/api/sites/${siteId}`).then((s) => {
      setSite(s);
      setForm({
        name: s.name,
        domain: s.domain,
        timezone: s.timezone,
        currency: s.currency,
        dodo_webhook_secret: s.dodo_webhook_secret ?? '',
        dodo_product_ids: s.dodo_product_ids ?? '',
        stripe_webhook_secret: s.stripe_webhook_secret ?? '',
      });
    });
  }, [siteId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 5000 : 2200);
    return () => clearTimeout(t);
  }, [toast]);

  async function save(patch: Partial<Site>, msg = 'Saved') {
    try {
      const s = await api<Site>(`/api/sites/${siteId}`, { method: 'PATCH', json: patch });
      setSite(s);
      setToast({ text: msg });
    } catch (e) {
      setToast({ text: (e as Error).message, error: true });
    }
  }

  const set = (patch: Partial<Site>) => setForm({ ...form, ...patch });
  const paymentsConnected = !!site && (!!site.dodo_webhook_secret || !!site.dodo_brand_id || !!site.stripe_webhook_secret);

  return (
    <Modal open side bare onClose={close}>
      <header className="flex items-center gap-3 border-b border-stone-200 bg-surface px-5 py-4">
        {site ? <Favicon domain={site.domain} size={26} /> : <span className="h-[26px] w-[26px] rounded bg-stone-100" />}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold leading-tight tracking-tight">{site ? `${site.name} settings` : 'Settings'}</h2>
          <p className="truncate text-[13px] text-stone-500">{site?.domain ?? ' '}</p>
        </div>
        <button className="icon-btn -mr-1.5" onClick={close} aria-label="Close settings">
          <CloseIcon />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-stone-200 bg-surface px-3 py-2 sm:w-52 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:py-4" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                tab === t.id ? 'bg-stone-100 font-medium text-ink' : t.id === 'delete' ? 'text-red-600 hover:bg-red-50' : 'text-stone-500 hover:bg-stone-50 hover:text-ink'
              } ${t.id === 'security' ? 'sm:mt-4' : ''}`}
            >
              {t.label}
              {t.id === 'payments' && paymentsConnected && <span className="h-1.5 w-1.5 rounded-full bg-live" title="Connected" />}
            </button>
          ))}
        </nav>

        <div className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[640px] px-5 py-7 sm:px-8">
            {!site ? (
              <div className="space-y-3">
                <div className="h-5 w-40 animate-pulse rounded bg-stone-200/70" />
                <div className="h-24 animate-pulse rounded-lg bg-stone-200/50" />
              </div>
            ) : tab === 'general' ? (
              <Section title="General" desc="How this website is named, and which timezone and currency its numbers use.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="set-name">
                      Name
                    </label>
                    <input id="set-name" className="input" value={form.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
                  </div>
                  <div>
                    <label className="label" htmlFor="set-domain">
                      Domain
                    </label>
                    <input id="set-domain" className="input" value={form.domain ?? ''} onChange={(e) => set({ domain: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Timezone</label>
                    <TimezoneSelect value={form.timezone ?? 'UTC'} onChange={(timezone) => set({ timezone })} />
                    <p className="hint">Where a day starts and ends.</p>
                  </div>
                  <div>
                    <label className="label">Revenue currency</label>
                    <CurrencySelect value={form.currency ?? 'USD'} onChange={(currency) => set({ currency })} />
                  </div>
                </div>
                <button className="btn-dark mt-6" onClick={() => save({ name: form.name, domain: form.domain, timezone: form.timezone, currency: form.currency }, 'Changes saved')}>
                  Save changes
                </button>
              </Section>
            ) : tab === 'install' ? (
              <>
                <Section title="Tracking script" desc={<>Put this in the &lt;head&gt; of every page on {site.domain}.</>}>
                  <Code label="HTML">{`<script defer data-website-id="${site.id}" src="${origin}/js/script.js"></script>`}</Code>
                  <details className="group mt-4 rounded-lg border border-stone-200 bg-surface px-4 py-3 text-sm">
                    <summary className="cursor-pointer font-medium text-stone-700">Next.js, and getting past ad blockers</summary>
                    <div className="mt-3 space-y-3">
                      <Code label="app/layout.tsx">{`import Script from 'next/script';

<Script defer data-website-id="${site.id}" src="${origin}/js/script.js" />`}</Code>
                      <p className="text-stone-500">Serve the script from your own domain so ad blockers don't stop it:</p>
                      <Code label="next.config.js">{`async rewrites() {
  return [
    { source: '/stats/script.js', destination: '${origin}/js/script.js' },
    { source: '/stats/event', destination: '${origin}/api/event' },
  ];
}
// then: <script defer data-website-id="${site.id}" data-api="/stats/event" src="/stats/script.js"></script>`}</Code>
                    </div>
                  </details>
                  <p className="mt-4 text-sm leading-relaxed text-stone-500">
                    Your own visits aren't counted from any browser you've opened this dashboard in. On other devices, like your phone, open{' '}
                    <code className="text-ink">{site.domain}/?ml_ignore=true</code> once.
                  </p>
                </Section>
                <AiSetup site={site} origin={origin} />
              </>
            ) : tab === 'goals' ? (
              <Section title="Goals" desc="Button clicks and other key actions. They show up under Goals on the dashboard.">
                <Code label="HTML and JavaScript">{`<button data-ml-goal="signup">Get started</button>

window.openAnalytics('goal', 'signup', { plan: 'pro' });
window.openAnalytics('identify', { email: user.email, name: user.name });`}</Code>
              </Section>
            ) : tab === 'payments' ? (
              <Revenue
                site={site}
                origin={origin}
                form={form}
                set={set}
                save={save}
                onKeyRotated={(api_key) => setSite({ ...site, api_key })}
                reload={async () => setSite(await api<Site>(`/api/sites/${siteId}`))}
              />
            ) : tab === 'links' ? (
              <LinkBuilder domain={site.domain} />
            ) : tab === 'sharing' ? (
              <Section
                title="Sharing"
                desc="A public dashboard shows visitors, revenue, sources, pages, places, devices, goals and an anonymous live map. Names, emails, settings and keys stay private, and only you can sign in."
              >
                <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-stone-200 bg-surface px-4 py-3">
                  <span>
                    <span className="block text-sm font-medium">Public dashboard</span>
                    <span className="block text-[13px] text-stone-500">{site.public ? 'Anyone with the link can see it.' : 'Only you can see it.'}</span>
                  </span>
                  <Switch
                    on={!!site.public}
                    label="Public dashboard"
                    onChange={(on) => save({ public: on ? 1 : 0 }, on ? 'Dashboard is public' : 'Dashboard is private')}
                  />
                </label>
                {!!site.public && (
                  <div className="mt-3">
                    <CopyField value={`${origin}/site/${site.id}`} />
                    <p className="hint">Changes can take up to a minute to show for visitors.</p>
                  </div>
                )}
              </Section>
            ) : tab === 'security' ? (
              <SecurityPanel />
            ) : (
              <DeleteSite site={site} />
            )}
          </div>
        </div>
      </div>

      {toast && (
        <div
          role="status"
          className={`oa-pop-in pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-lg px-3.5 py-2 text-sm font-medium shadow-pop ${
            toast.error ? 'bg-red-600 text-white' : 'bg-ink text-paper'
          }`}
        >
          {toast.text}
        </div>
      )}
    </Modal>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? 'bg-visitors' : 'bg-stone-300'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

/** Deleting asks you to type the domain first, right here rather than in a browser prompt. */
function DeleteSite({ site }: { site: Site }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Delete website" desc={`Removes ${site.name} and everything recorded for it: visits, payments, goals and settings. This can't be undone.`}>
      <label className="label" htmlFor="del-confirm">
        Type <span className="font-mono text-ink">{site.domain}</span> to confirm
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input id="del-confirm" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        <button
          className="inline-flex shrink-0 items-center justify-center rounded-lg bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          disabled={typed.trim().toLowerCase() !== site.domain.toLowerCase() || busy}
          onClick={async () => {
            setBusy(true);
            await api(`/api/sites/${site.id}`, { method: 'DELETE' });
            navigate('/', { replace: true });
          }}
        >
          {busy ? 'Deleting…' : 'Delete website'}
        </button>
      </div>
    </Section>
  );
}

type Provider = 'dodo' | 'stripe' | 'api';

interface RevenueProps {
  site: Site;
  origin: string;
  form: Partial<Site>;
  set: (patch: Partial<Site>) => void;
  save: (patch: Partial<Site>, msg?: string) => Promise<void>;
  onKeyRotated: (key: string) => void;
  /** Re-read the site (after connecting Dodo, picking a brand or syncing). */
  reload: () => Promise<void>;
}

/** Revenue attribution: pick the payment provider, see only its setup. */
function Revenue(props: RevenueProps) {
  const { site } = props;
  const [provider, setProvider] = useState<Provider>(site.stripe_webhook_secret && !site.dodo_webhook_secret ? 'stripe' : 'dodo');
  const tabs: { id: Provider; label: string; icon: ReactNode; connected?: boolean }[] = [
    { id: 'dodo', label: 'Dodo Payments', icon: <Favicon domain="dodopayments.com" size={18} />, connected: !!site.dodo_webhook_secret || !!site.dodo_brand_id },
    { id: 'stripe', label: 'Stripe', icon: <Favicon domain="stripe.com" size={18} />, connected: !!site.stripe_webhook_secret },
    { id: 'api', label: 'Other / API', icon: <span className="font-mono text-xs text-stone-500">{'{ }'}</span> },
  ];
  return (
    <Section title="Payments" desc="Each payment is linked to the visitor who paid and to the source that brought them.">
      <div className="mb-5 grid grid-cols-3 gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setProvider(t.id)}
            className={`relative flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
              provider === t.id ? 'border-ink bg-stone-50 ring-1 ring-ink' : 'border-stone-200 text-stone-600 hover:bg-stone-50'
            }`}
          >
            {t.icon}
            <span className="truncate">{t.label}</span>
            {t.connected && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-emerald-500" title="Connected" />}
          </button>
        ))}
      </div>
      {provider === 'dodo' && <DodoSetup {...props} />}
      {provider === 'stripe' && <StripeSetup {...props} />}
      {provider === 'api' && <ApiSetup {...props} />}
    </Section>
  );
}

interface DodoBrand {
  brand_id: string;
  name: string | null;
  url: string | null;
  statement_descriptor: string;
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url.includes('://') ? url : `https://${url}`).hostname : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Dodo by API key: paste a key, pick which of the account's brands is this site, and payments are pulled
 * every 10 minutes. No webhook to set up. The key is stored encrypted on the server and never comes back.
 */
function DodoApiConnect({ site, reload }: { site: Site; reload: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [brands, setBrands] = useState<DodoBrand[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const connected = !!site.dodo_api_connected;
  const choosing = connected && (!site.dodo_brand_id || picking);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // Connected but no brand yet (or changing it): fetch the account's brands to choose from.
  useEffect(() => {
    if (!choosing || brands) return;
    api<DodoBrand[]>(`/api/sites/${site.id}/dodo/brands`)
      .then(setBrands)
      .catch((e) => setNote({ ok: false, text: (e as Error).message }));
  }, [choosing, brands, site.id]);

  const synced = (r: { payments: number; refunds: number }) =>
    `Pulled ${r.payments} new payment${r.payments === 1 ? '' : 's'}${r.refunds ? ` and ${r.refunds} refund${r.refunds === 1 ? '' : 's'}` : ''}.`;

  const Note = () => (note ? <p className={`mt-3 text-sm ${note.ok ? 'text-emerald-500' : 'text-red-500'}`}>{note.text}</p> : null);

  if (!connected) {
    return (
      <div className="rounded-xl border border-stone-200 p-4">
        <div className="flex flex-wrap items-center gap-2 font-medium">
          Connect with an API key
          <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-800">Recommended</span>
        </div>
        <p className="mt-1 text-sm text-stone-500">
          In Dodo → <b>Developer → API keys</b>, create a key with <b>Read</b> access to <b>Brands</b>, <b>Payments</b> and <b>Refunds</b> (nothing else is
          needed) and paste it here. You then pick which of your Dodo brands is {site.domain}, and its payments are pulled every 10 minutes. The key is
          stored encrypted and never shown again.
        </p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run('connect', async () => {
              const r = await api<{ brands: DodoBrand[]; brand_id: string | null }>(`/api/sites/${site.id}/dodo/connect`, { method: 'POST', json: { apiKey: key } });
              setKey('');
              setBrands(r.brands);
              await reload();
              if (r.brand_id) {
                const s = await api<{ payments: number; refunds: number }>(`/api/sites/${site.id}/dodo/sync`, { method: 'POST' });
                await reload();
                setNote({ ok: true, text: `Connected to your only brand. ${synced(s)}` });
              }
            });
          }}
        >
          <input
            className="input font-mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="dodo_live_…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="btn-dark shrink-0" disabled={!key.trim() || busy === 'connect'}>
            {busy === 'connect' ? 'Checking…' : 'Connect'}
          </button>
        </form>
        <Note />
      </div>
    );
  }

  if (choosing) {
    return (
      <div className="rounded-xl border border-stone-200 p-4">
        <div className="font-medium">Which Dodo brand is {site.domain}?</div>
        <p className="mt-1 text-sm text-stone-500">
          These are the brands in your Dodo account ({site.dodo_api_mode} mode). Payments of the one you pick are counted here.
        </p>
        {!brands && !note && <div className="mt-3 h-14 animate-pulse rounded-xl bg-stone-100" />}
        {brands && brands.length === 0 && <p className="mt-3 text-sm text-stone-500">This Dodo account has no brands yet.</p>}
        <div className="mt-3 space-y-2">
          {brands?.map((b) => (
            <button
              key={b.brand_id}
              disabled={!!busy}
              onClick={() =>
                run(`brand:${b.brand_id}`, async () => {
                  const r = await api<{ payments?: number; refunds?: number; syncError?: string }>(`/api/sites/${site.id}/dodo/brand`, {
                    method: 'POST',
                    json: { brandId: b.brand_id },
                  });
                  setPicking(false);
                  await reload();
                  setNote(r.syncError ? { ok: false, text: r.syncError } : { ok: true, text: synced({ payments: r.payments ?? 0, refunds: r.refunds ?? 0 }) });
                })
              }
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition hover:bg-stone-50 disabled:opacity-60 ${
                b.brand_id === site.dodo_brand_id ? 'border-ink' : 'border-stone-200'
              }`}
            >
              <Favicon domain={hostOf(b.url)} size={20} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{b.name ?? b.statement_descriptor}</span>
                <span className="block truncate text-xs text-stone-500">{b.url ?? b.brand_id}</span>
              </span>
              {busy === `brand:${b.brand_id}` && <span className="text-xs text-stone-500">Pulling payments…</span>}
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          {picking && (
            <button className="btn py-1.5" onClick={() => setPicking(false)}>
              Cancel
            </button>
          )}
          <button
            className="btn py-1.5 text-red-500"
            disabled={!!busy}
            onClick={() => run('disconnect', async () => (await api(`/api/sites/${site.id}/dodo`, { method: 'DELETE' }), setBrands(null), await reload()))}
          >
            Remove key
          </button>
        </div>
        <Note />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-medium">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          Connected to {site.dodo_brand_name ?? 'your Dodo brand'}
          <span className="text-xs font-normal text-stone-500">{site.dodo_api_mode} mode</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn py-1.5"
            disabled={!!busy}
            onClick={() =>
              run('sync', async () => {
                const r = await api<{ payments: number; refunds: number }>(`/api/sites/${site.id}/dodo/sync`, { method: 'POST' });
                await reload();
                setNote({ ok: true, text: synced(r) });
              })
            }
          >
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
          <button className="btn py-1.5" disabled={!!busy} onClick={() => (setBrands(null), setPicking(true))}>
            Change brand
          </button>
          <button
            className="btn py-1.5 text-red-500"
            disabled={!!busy}
            onClick={() => {
              if (!confirm('Disconnect Dodo? Payments already pulled stay; new ones stop arriving until you connect again.')) return;
              run('disconnect', async () => (await api(`/api/sites/${site.id}/dodo`, { method: 'DELETE' }), setBrands(null), await reload()));
            }}
          >
            Disconnect
          </button>
        </div>
      </div>
      <p className="mt-2 text-sm text-stone-500">
        Payments since {site.dodo_sync_from ? new Date(site.dodo_sync_from).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
        {' · '}
        {site.dodo_synced_at ? `last synced ${fmtAgo(Date.now() - site.dodo_synced_at) || 'just now'}${fmtAgo(Date.now() - site.dodo_synced_at) ? ' ago' : ''}` : 'not synced yet'}
        {' · '}checks every 10 minutes
      </p>
      {site.dodo_sync_error && <p className="mt-2 text-sm text-red-500">Last sync failed: {site.dodo_sync_error}</p>}
      <Note />
    </div>
  );
}

function DodoSetup({ site, origin, form, set, save, reload }: RevenueProps) {
  return (
    <>
      <DodoApiConnect site={site} reload={reload} />
      <div className="mt-5">
        <Steps>
          <Step n={1} title="Pass the visitor to your checkout, so each payment is credited to where the buyer came from. Payment links need nothing: the script tags them.">
            <Code label="checkout.ts">{`const jar = await cookies(); // next/headers

await dodo.checkoutSessions.create({
  // ...your existing options
  return_url: 'https://${site.domain}/thanks',
  metadata: {
    ml_visitor_id: jar.get('ml_vid')?.value ?? '',
    ml_session_id: jar.get('ml_sid')?.value ?? '',
  },
});`}</Code>
          </Step>
        </Steps>
      </div>
      <details className="mt-5 text-sm" open={!!site.dodo_webhook_secret && !site.dodo_api_connected}>
        <summary className="cursor-pointer font-medium text-stone-600">Or use a webhook instead (instant, no API key)</summary>
        <div className="mt-3">
          <Steps>
            <Step
              n={1}
              title={
                <>
                  In Dodo → <b>Developer → Webhooks</b>, add this endpoint with <code>payment.succeeded</code> and <code>refund.succeeded</code>:
                </>
              }
            >
              <CopyField value={`${origin}/api/webhooks/dodo/${site.id}`} />
            </Step>
            <Step n={2} title="Paste its signing secret:">
              <SecretField
                value={form.dodo_webhook_secret ?? ''}
                configured={!!site.dodo_webhook_secret}
                onChange={(v) => set({ dodo_webhook_secret: v })}
                onSave={() => save({ dodo_webhook_secret: form.dodo_webhook_secret ?? '' }, 'Dodo connected')}
              />
            </Step>
          </Steps>
        </div>
      </details>
      <details className="mt-5 text-sm">
        <summary className="cursor-pointer font-medium text-stone-600">Selling other products from the same Dodo account?</summary>
        <p className="mt-2 text-stone-500">List this site's product ids so only their payments count.</p>
        <div className="mt-2 flex gap-2">
          <input
            className="input font-mono"
            placeholder="pdt_abc123, pdt_def456"
            value={form.dodo_product_ids ?? ''}
            onChange={(e) => set({ dodo_product_ids: e.target.value })}
          />
          <button className="btn-dark" onClick={() => save({ dodo_product_ids: form.dodo_product_ids ?? '' }, 'Products saved')}>
            Save
          </button>
        </div>
      </details>
      <PendingDodoPayments site={site} />
      <ProviderFooter />
    </>
  );
}

const currencyDecimals = (c: string) => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};

interface PendingProduct {
  product_id: string | null;
  count: number;
  amount: number;
  currency: string | null;
}

/** Payments from a product this dashboard couldn't link to any site yet. Rare: most are placed automatically. */
function PendingDodoPayments({ site }: { site: Site }) {
  const [rows, setRows] = useState<PendingProduct[]>([]);
  const load = () => api<PendingProduct[]>(`/api/sites/${site.id}/pending-payments`).then(setRows);
  useEffect(() => {
    load();
  }, [site.id]);
  if (!rows.length) return null;
  return (
    <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
      <p className="font-medium text-amber-900">Payments waiting for a site</p>
      <p className="mt-1 text-amber-800">
        These came from a product none of your sites links to yet, so they aren't counted anywhere. They're placed automatically once a buyer
        comes from {site.name}. Know they're {site.name}'s? Count them now.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li key={r.product_id ?? ''} className="flex items-center justify-between gap-3">
            <span>
              <code>{r.product_id ?? 'unknown product'}</code> · {r.count} payment{r.count === 1 ? '' : 's'},{' '}
              {fmtMoney(r.amount, r.currency ?? site.currency, currencyDecimals(r.currency ?? site.currency))}
            </span>
            {r.product_id && (
              <button
                className="btn shrink-0"
                onClick={() => api(`/api/sites/${site.id}/pending-payments`, { method: 'POST', json: { product_id: r.product_id } }).then(load)}
              >
                Count for {site.name}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StripeSetup({ site, origin, form, set, save }: RevenueProps) {
  return (
    <>
      <Steps>
        <Step
          n={1}
          title={
            <>
              In Stripe → <b>Developers → Webhooks</b>, add this endpoint with <code>checkout.session.completed</code>,{' '}
              <code>invoice.paid</code> and <code>charge.refunded</code>:
            </>
          }
        >
          <CopyField value={`${origin}/api/webhooks/stripe/${site.id}`} />
        </Step>
        <Step n={2} title="Paste its signing secret:">
          <SecretField
            value={form.stripe_webhook_secret ?? ''}
            configured={!!site.stripe_webhook_secret}
            onChange={(v) => set({ stripe_webhook_secret: v })}
            onSave={() => save({ stripe_webhook_secret: form.stripe_webhook_secret ?? '' }, 'Stripe connected')}
          />
        </Step>
        <Step n={3} title="Pass the visitor to your checkout:">
          <Code label="checkout.ts">{`const jar = await cookies(); // next/headers

await stripe.checkout.sessions.create({
  // ...your existing options
  success_url: 'https://${site.domain}/thanks?session_id={CHECKOUT_SESSION_ID}',
  metadata: {
    ml_visitor_id: jar.get('ml_vid')?.value ?? '',
    ml_session_id: jar.get('ml_sid')?.value ?? '',
    ml_site_id: '${site.id}', // only needed if one Stripe account sells for several sites
  },
});`}</Code>
          <p className="text-stone-500">
            Using <b>Payment Links</b>? No code needed. Set the link's confirmation page to redirect to{' '}
            <code>https://{site.domain}/thanks?session_id={'{CHECKOUT_SESSION_ID}'}</code>.
          </p>
        </Step>
      </Steps>
      <ProviderFooter />
    </>
  );
}

function ApiSetup({ site, origin, onKeyRotated }: RevenueProps) {
  return (
    <>
      <p className="mb-3 text-sm text-stone-500">Any other provider: send payments from your backend with this site's API key.</p>
      <div className="mb-4 flex gap-2">
        <input className="input font-mono" readOnly value={site.api_key} />
        <button
          className="btn"
          onClick={async () => {
            if (!confirm('Rotate the API key? The old key stops working immediately.')) return;
            const r = await api<{ api_key: string }>(`/api/sites/${site.id}/rotate-key`, { method: 'POST' });
            onKeyRotated(r.api_key);
          }}
        >
          Rotate
        </button>
      </div>
      <Code label="POST /api/v1/payments">{`curl -X POST ${origin}/api/v1/payments \\
  -H "Authorization: Bearer ${site.api_key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "transaction_id": "txn_123",
    "amount": 29.99,
    "currency": "${site.currency}",
    "visitor_id": "<ml_vid cookie>",
    "email": "jane@acme.com"
  }'`}</Code>
    </>
  );
}

function ProviderFooter({ note = 'No metadata? Payments are still matched by return page, email or timing.' }: { note?: string }) {
  return (
    <p className="mt-5 border-t border-stone-100 pt-4 text-sm text-stone-500">
      {note}
    </p>
  );
}

/** One-click prompt for the owner's coding AI, so it can install everything in their codebase. */
function AiSetup({ site, origin }: { site: Site; origin: string }) {
  const [open, setOpen] = useState(false);
  const prompt = buildAiPrompt(site, origin);
  return (
    <section className="rounded-lg border border-stone-200 bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Set it up with an AI coding tool</h3>
          <p className="mt-0.5 text-[13px] text-stone-500">Paste this into Claude Code or Cursor in the website's project. It adds the script, goals and payment tracking.</p>
        </div>
        <CopyButton text={prompt} label="Copy prompt" className="btn shrink-0" />
      </div>
      <button className="mt-2 text-[13px] font-medium text-stone-600 underline decoration-stone-300 underline-offset-2 hover:text-ink" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide the prompt' : 'Read the prompt'}
      </button>
      {open && <pre className="code mt-3 max-h-96 whitespace-pre-wrap rounded-lg">{prompt}</pre>}
    </section>
  );
}

const PRESETS = [
  { label: 'X / Twitter', source: 'x', medium: 'social' },
  { label: 'LinkedIn', source: 'linkedin', medium: 'social' },
  { label: 'Reddit', source: 'reddit', medium: 'social' },
  { label: 'YouTube', source: 'youtube', medium: 'video' },
  { label: 'Medium', source: 'medium', medium: 'article' },
  { label: 'Newsletter', source: 'newsletter', medium: 'email' },
  { label: 'Product Hunt', source: 'producthunt', medium: 'referral' },
];

/** Build a tagged link per tweet / article, so each one shows up separately in Campaign. */
function LinkBuilder({ domain }: { domain: string }) {
  const [url, setUrl] = useState(`https://${domain}/`);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [campaign, setCampaign] = useState('');
  let built = '';
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', preset.source);
    u.searchParams.set('utm_medium', preset.medium);
    if (campaign) u.searchParams.set('utm_campaign', campaign.trim().toLowerCase().replace(/\s+/g, '-'));
    built = u.toString();
  } catch {}
  return (
    <Section title="Campaign links" desc="Tag the link you share in each post, so the dashboard shows which post brought visitors and revenue (under Referrer, then Campaign).">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <label className="label">Page</label>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div>
          <label className="label">Where you post it</label>
          <select className="input" value={preset.label} onChange={(e) => setPreset(PRESETS.find((p) => p.label === e.target.value)!)}>
            {PRESETS.map((p) => (
              <option key={p.label}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Post name</label>
          <input className="input" placeholder="launch-tweet" value={campaign} onChange={(e) => setCampaign(e.target.value)} />
        </div>
      </div>
      {built && (
        <div className="mt-4">
          <CopyField value={built} />
        </div>
      )}
    </Section>
  );
}
