import { useCallback, useEffect, useRef, useState } from 'react';
import { currencyDecimals } from '../../shared/currency';
import { displayName } from '../../shared/names';
import { api, type Site } from '../lib/api';
import { launchFireworks } from '../lib/fireworks';
import { fmtMoney } from '../lib/format';
import { usePref } from '../lib/prefs';
import { playCashRegister, unlockAudio } from '../lib/sounds';
import { BellIcon, CloseIcon, RefreshIcon } from './Icons';

interface NewPayment {
  id: string;
  site_id: string;
  ts: number;
  amount: number;
  currency: string;
  renewal: number;
  name: string | null;
  email: string | null;
  visitor_id: string | null;
  source: string | null;
  campaign: string | null;
}
interface Check {
  cursor: number;
  payments: NewPayment[];
  checked_at: number;
}

const EVERY_MS = 20_000;
const TOAST_MS = 12_000;

/**
 * The "Live payments" switch. While it's on, the server is asked every 20 seconds (and on "Check now") for
 * payments since the last check; Dodo sites connected by API key are pulled from Dodo right then. Each new
 * payment rings a cash register, sets off fireworks and shows who paid. `siteId` limits it to one site.
 */
export function LivePayments({ sites, siteId, onNew }: { sites: Site[]; siteId?: string; onNew?: () => void }) {
  const [on, setOn] = usePref('oa_live_payments', false);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [toasts, setToasts] = useState<NewPayment[]>([]);
  const [, tick] = useState(0);
  const cursor = useRef<number | undefined>(undefined);
  const seen = useRef(new Set<string>());
  const busy = useRef(false);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try {
      const r = await api<Check>('/api/payments/check', { method: 'POST', json: { cursor: cursor.current, site: siteId } });
      cursor.current = r.cursor;
      setCheckedAt(r.checked_at);
      const fresh = r.payments.filter((p) => !seen.current.has(p.id));
      fresh.forEach((p) => seen.current.add(p.id));
      if (fresh.length) {
        playCashRegister();
        launchFireworks(Math.min(6, 3 + fresh.length));
        setToasts((t) => [...fresh.slice(-3).reverse(), ...t].slice(0, 4));
        onNewRef.current?.();
      }
    } catch {
      // Offline or signed out: the next check tries again.
    } finally {
      busy.current = false;
      setChecking(false);
    }
  }, [siteId]);

  // A new scope (another site, or all sites) starts from "now" again.
  useEffect(() => {
    cursor.current = undefined;
  }, [siteId]);

  useEffect(() => {
    if (!on) return;
    check();
    const t = setInterval(check, EVERY_MS);
    const label = setInterval(() => tick((n) => n + 1), 5_000);
    return () => {
      clearInterval(t);
      clearInterval(label);
    };
  }, [on, check]);

  // Each card leaves on its own after a while.
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => setToasts((list) => list.slice(0, -1)), TOAST_MS);
    return () => clearTimeout(t);
  }, [toasts]);

  const ago = checkedAt ? Math.max(0, Math.round((Date.now() - checkedAt) / 1000)) : null;
  const siteOf = (id: string) => sites.find((s) => s.id === id);

  return (
    <>
      {on ? (
        <div className="flex h-9 items-stretch rounded-lg border border-emerald-200 bg-emerald-50">
          <button
            className="flex items-center gap-2 rounded-l-lg px-3 text-sm font-medium text-emerald-800 transition-colors hover:bg-emerald-100"
            onClick={() => setOn(false)}
            title="Live payments is on: new payments ring and set off fireworks. Click to turn it off."
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-live opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-live" />
            </span>
            Live payments
            {ago !== null && <span className="hidden text-xs font-normal opacity-70 lg:inline">checked {ago < 5 ? 'just now' : `${ago}s ago`}</span>}
          </button>
          <button
            className="flex w-9 items-center justify-center rounded-r-lg border-l border-emerald-200 text-emerald-800 transition-colors hover:bg-emerald-100"
            onClick={check}
            aria-label="Check for new payments now"
            title="Check now"
          >
            <RefreshIcon size={15} spinning={checking} />
          </button>
        </div>
      ) : (
        <button
          className="btn h-9"
          onClick={() => {
            unlockAudio(); // browsers only allow sound after a click
            setOn(true);
          }}
          title="Ring and show fireworks when someone pays. Checks every 20 seconds while this page is open."
        >
          <BellIcon size={15} /> Live payments
        </button>
      )}

      {toasts.length > 0 && (
        <div className="fixed right-4 top-4 z-[90] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
          {toasts.map((p) => {
            const site = siteOf(p.site_id);
            const who = p.visitor_id ? displayName(p.visitor_id, p.name, p.email) : p.name || p.email || 'Someone';
            const via = [p.source, p.campaign && `campaign ${p.campaign}`].filter(Boolean).join(', ');
            return (
              <div key={p.id} className="oa-pop-in pop flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-revenueSoft text-lg" aria-hidden="true">
                  $
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-semibold">{who}</span> {p.renewal ? 'renewed for' : 'paid'}{' '}
                    <span className="num font-semibold text-ink">{fmtMoney(p.amount, p.currency, currencyDecimals(p.currency))}</span>
                  </p>
                  <p className="truncate text-[13px] text-stone-500">
                    {site?.name ?? 'Your site'}
                    {via ? `, via ${via}` : ''}
                  </p>
                </div>
                <button className="icon-btn -mr-2 -mt-1 h-7 w-7" onClick={() => setToasts((t) => t.filter((x) => x.id !== p.id))} aria-label="Dismiss">
                  <CloseIcon size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
