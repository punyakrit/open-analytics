import { useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { countryName, flag, fmtAgo } from '../lib/format';
import { useApi } from '../lib/useApi';

interface Activity {
  attempts: { ts: number; ok: boolean; country: string | null; network: string; yours: boolean }[];
  failedLastDay: number;
  lockedNetworks: number;
  limits: { maxFailures: number; windowMinutes: number; firstLockMinutes: number; sessionDays: number };
}

/** Settings → Sign-in security. It covers the whole dashboard, not one website. */
export function SecurityPanel() {
  const { data, error } = useApi<Activity>('/api/auth/activity');
  const [confirming, setConfirming] = useState(false);

  async function signOutEverywhere() {
    await api('/api/auth/logout-all', { method: 'POST' });
    window.dispatchEvent(new Event('ml:logout'));
  }

  return (
    <>
      <section className="mb-10">
        <h3 className="text-[17px] font-semibold tracking-tight">Sign-in security</h3>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">These apply to the whole dashboard, not just this website.</p>

        {data && (
          <ul className="mt-4 divide-y divide-stone-100 rounded-lg border border-stone-200 bg-surface text-sm">
            <Rule>
              After {data.limits.maxFailures} wrong passwords from one network in {data.limits.windowMinutes} minutes, that network is locked out for{' '}
              {data.limits.firstLockMinutes} minutes. Each lock after that lasts twice as long, up to a day.
            </Rule>
            <Rule>If many networks guess at once, sign-in pauses for browsers that have never signed in before.</Rule>
            <Rule>Every answer takes about a second, right or wrong, so guessing is slow.</Rule>
            <Rule>
              You stay signed in for {data.limits.sessionDays} days on each device. The sign-in cookie can't be read by scripts and is never sent from other
              sites.
            </Rule>
            <Rule>The sign-in page only accepts requests from this dashboard, and pages here only run this site's own scripts.</Rule>
          </ul>
        )}
      </section>

      <section className="mb-10">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[17px] font-semibold tracking-tight">Recent sign-in attempts</h3>
          {data && (
            <span className="text-[13px] text-stone-500">
              {data.failedLastDay} wrong in the last day{data.lockedNetworks ? `, ${data.lockedNetworks} network${data.lockedNetworks === 1 ? '' : 's'} locked now` : ''}
            </span>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {data && !data.attempts.length && <p className="mt-3 text-sm text-stone-500">No attempts recorded yet.</p>}
        {data && data.attempts.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-lg border border-stone-200 bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-left text-xs text-stone-500">
                  <th className="px-4 py-2 font-normal">When</th>
                  <th className="px-4 py-2 font-normal">Result</th>
                  <th className="hidden px-4 py-2 font-normal sm:table-cell">Where</th>
                  <th className="px-4 py-2 font-normal">Network</th>
                </tr>
              </thead>
              <tbody>
                {data.attempts.map((a, i) => (
                  <tr key={i} className="border-b border-stone-100 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-stone-600" title={new Date(a.ts).toLocaleString()}>
                      {fmtAgo(a.ts)}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center gap-1.5 ${a.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${a.ok ? 'bg-emerald-600' : 'bg-red-600'}`} />
                        {a.ok ? 'Signed in' : 'Wrong password'}
                      </span>
                    </td>
                    <td className="hidden px-4 py-2 text-stone-600 sm:table-cell">{a.country ? `${flag(a.country)} ${countryName(a.country)}` : 'Unknown'}</td>
                    <td className="px-4 py-2 font-mono text-[12px] text-stone-500">
                      {a.network}
                      {a.yours && <span className="ml-1.5 font-sans text-[11px] text-stone-400">you</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-[17px] font-semibold tracking-tight">Sign out everywhere</h3>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">Ends every session on every device, this one included. Use it if a device is lost or you think the password leaked (then change the password too).</p>
        {confirming ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="inline-flex items-center rounded-lg bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white hover:opacity-90" onClick={signOutEverywhere}>
              Sign out everywhere now
            </button>
            <button className="btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn mt-4" onClick={() => setConfirming(true)}>
            Sign out everywhere
          </button>
        )}
      </section>
    </>
  );
}

const Rule = ({ children }: { children: ReactNode }) => <li className="px-4 py-2.5 leading-relaxed text-stone-600">{children}</li>;
