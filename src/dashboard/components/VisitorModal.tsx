import { useMemo, useState, type ReactNode } from 'react';
import { displayName } from '../../shared/names';
import { useDash } from '../lib/context';
import { countryName, dayInTz, fmtCharged, fmtDuration } from '../lib/format';
import { useApi } from '../lib/useApi';
import { CopyButton } from './CodeBlock';
import { Avatar, BrowserIcon, CloseIcon, DeviceIcon, Flag, OSIcon, SourceIcon } from './Icons';
import { Modal } from './Modal';

interface Session {
  id: string;
  started_at: number;
  last_seen_at: number;
  duration: number;
  pageviews: number;
  source: string;
  referrer: string | null;
  referrer_domain: string | null;
  utm_campaign: string | null;
  ref: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
}
interface Payment {
  id: string;
  ts: number;
  amount: number;
  kind: 'payment' | 'refund';
  renewal?: number | null;
  original_amount?: number | null;
  original_currency?: string | null;
}
interface Profile {
  visitor: { id: string; first_seen: number; name: string | null; email: string | null; user_id: string | null } | null;
  sessions: Session[];
  events: { session_id: string; ts: number; type: string; name: string | null; path: string; props: string | null }[];
  payments: Payment[];
}

/** One line of the timeline. Repeated views of the same page in a row become one line with a count. */
type Item =
  | { ts: number; kind: 'arrive'; session: Session }
  | { ts: number; kind: 'page'; path: string; times: number }
  | { ts: number; kind: 'goal'; name: string; path: string }
  | { ts: number; kind: 'outbound'; to: string }
  | { ts: number; kind: 'payment'; payment: Payment };

const DAY = 86_400_000;
const WEEKS = 20;

/**
 * A visitor's profile, rising from the bottom: who they are on the left, everything they did grouped by day
 * in the middle, and what it added up to on the right.
 */
export function VisitorModal({ visitorId, onClose }: { visitorId: string | null; onClose: () => void }) {
  const { site } = useDash();
  // The parent remounts this per visitor (key), so `data` always belongs to `visitorId`.
  const { data: p } = useApi<Profile>(visitorId ? `/api/sites/${site.id}/visitors/${visitorId}` : null);
  return (
    <Modal open={!!visitorId} onClose={onClose} sheet bare>
      <div className="relative flex shrink-0 items-center justify-center pb-1 pt-2.5">
        <span className="h-1 w-10 rounded-full bg-stone-300" aria-hidden="true" />
        <button className="icon-btn absolute right-2 top-1.5" onClick={onClose} aria-label="Close profile">
          <CloseIcon />
        </button>
      </div>
      {p && visitorId ? (
        <ProfileBody id={visitorId} p={p} />
      ) : (
        <div className="grid flex-1 gap-4 p-6 lg:grid-cols-[260px_1fr_280px]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-64 animate-pulse rounded-xl bg-stone-100" />
          ))}
        </div>
      )}
    </Modal>
  );
}

function ProfileBody({ id, p }: { id: string; p: Profile }) {
  const { site, money } = useDash();
  const [newestFirst, setNewestFirst] = useState(false);
  const tz = site.timezone;
  const last = p.sessions[0];
  const name = displayName(id, p.visitor?.name, p.visitor?.email);
  const firstSeen = p.visitor?.first_seen ?? p.sessions.at(-1)?.started_at ?? Date.now();
  const payments = p.payments.filter((x) => x.kind === 'payment');
  const spent = p.payments.reduce((n, x) => n + x.amount, 0);
  const firstPayment = payments.at(-1);
  const pageviews = p.events.filter((e) => e.type === 'pageview').length;

  const days = useMemo(() => buildTimeline(p, tz, newestFirst), [p, tz, newestFirst]);
  const time = (ts: number) => new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(ts);
  const dayTitle = (ts: number) => new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }).format(ts);
  const asText = days
    .map(([day, items]) => [dayTitle(day), ...items.map((it) => `  ${time(it.ts)}  ${describe(it, site.domain, money).text}`)].join('\n'))
    .join('\n\n');

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-y-auto lg:grid-cols-[260px_minmax(0,1fr)_300px] lg:grid-rows-1 lg:overflow-hidden">
      {/* Who */}
      <aside className="border-b border-stone-200 px-6 pb-6 pt-2 lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <Avatar id={id} size={76} />
        <h2 className="mt-3 text-xl font-semibold tracking-tight">{name}</h2>
        {p.visitor?.email && p.visitor.name && <p className="truncate text-sm text-stone-500">{p.visitor.email}</p>}
        {spent > 0 && (
          <span className="mt-2 inline-flex rounded-full bg-revenueSoft px-2 py-0.5 text-xs font-medium text-ink">Customer</span>
        )}
        {last && (
          <ul className="mt-5 space-y-2.5 text-sm">
            <Fact icon={<Flag cc={last.country} size={16} />}>{[last.city, countryName(last.country)].filter(Boolean).join(', ')}</Fact>
            <Fact icon={<DeviceIcon name={last.device} size={16} />}>{last.device ?? 'Unknown device'}</Fact>
            <Fact icon={<OSIcon name={last.os} size={16} />}>{last.os ?? 'Unknown system'}</Fact>
            <Fact icon={<BrowserIcon name={last.browser} size={16} />}>{last.browser ?? 'Unknown browser'}</Fact>
          </ul>
        )}
        <dl className="mt-6 space-y-2 border-t border-stone-200 pt-4 text-sm">
          <Row label="First seen" value={new Intl.DateTimeFormat('en', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(firstSeen)} />
          <Row label="Visits" value={String(p.sessions.length)} />
          <Row label="Time on site" value={fmtDuration(p.sessions.reduce((n, s) => n + s.duration, 0))} />
          {p.visitor?.user_id && <Row label="User ID" value={p.visitor.user_id} mono />}
        </dl>
      </aside>

      {/* What they did */}
      <section className="flex min-h-0 flex-col lg:overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-5 py-3">
          <h3 className="text-sm font-semibold">Activity</h3>
          <div className="flex items-center gap-1">
            <button className="btn-ghost text-xs" onClick={() => setNewestFirst((v) => !v)}>
              {newestFirst ? 'Newest first' : 'Oldest first'}
            </button>
            <CopyButton text={`${name}\n\n${asText}`} label="Copy" />
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-4 px-5 pb-8 lg:overflow-y-auto">
          {days.map(([day, items]) => (
            <div key={day} className="overflow-hidden rounded-xl border border-stone-200 bg-surface">
              <div className="border-b border-stone-100 bg-stone-50 px-4 py-2 text-center text-[13px] font-medium">{dayTitle(day)}</div>
              <ol>
                {items.map((it, i) => {
                  const d = describe(it, site.domain, money);
                  return (
                    <li key={i} className="flex items-center gap-3 border-b border-stone-100 px-4 py-2.5 text-sm last:border-0">
                      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${d.tone}`}>{d.icon}</span>
                      <span className="min-w-0 flex-1 truncate">{d.node}</span>
                      <span className="num shrink-0 text-[13px] text-stone-500">{time(it.ts)}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
          {!days.length && <p className="py-10 text-center text-sm text-stone-500">Nothing recorded yet.</p>}
        </div>
      </section>

      {/* What it added up to */}
      <aside className="border-t border-stone-200 px-6 py-5 lg:overflow-y-auto lg:border-l lg:border-t-0">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat value={String(pageviews)} label="pageviews" />
          <Stat value={money(spent, true)} label="spent" accent={spent > 0} />
          <Stat
            value={firstPayment ? daysBetween(firstSeen, firstPayment.ts) : String(p.sessions.length)}
            label={firstPayment ? 'to first payment' : p.sessions.length === 1 ? 'visit' : 'visits'}
          />
        </div>

        <h3 className="mt-7 text-sm font-semibold">Last {WEEKS} weeks</h3>
        <Heatmap p={p} tz={tz} />

        {p.payments.length > 0 && (
          <>
            <h3 className="mt-7 text-sm font-semibold">Payments</h3>
            <ul className="mt-2 divide-y divide-stone-100 rounded-lg border border-stone-200 bg-surface text-sm">
              {p.payments.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-stone-600">
                    {new Intl.DateTimeFormat('en', { timeZone: tz, day: 'numeric', month: 'short' }).format(x.ts)}{' '}
                    <span className="text-stone-400">{x.kind === 'refund' ? 'refund' : x.renewal ? 'renewal' : 'payment'}</span>
                  </span>
                  <span className={`num font-medium ${x.amount < 0 ? 'text-red-500' : ''}`}>
                    {money(x.amount)}
                    {fmtCharged(x.original_amount, x.original_currency) && (
                      <span className="ml-1.5 font-normal text-stone-400">{fmtCharged(x.original_amount, x.original_currency)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}

function buildTimeline(p: Profile, tz: string, newestFirst: boolean): [number, Item[]][] {
  const raw: Item[] = [
    ...p.sessions.map((s) => ({ ts: s.started_at, kind: 'arrive' as const, session: s })),
    ...p.events.flatMap((e): Item[] =>
      e.type === 'pageview'
        ? [{ ts: e.ts, kind: 'page', path: e.path, times: 1 }]
        : e.type === 'goal'
          ? [{ ts: e.ts, kind: 'goal', name: e.name ?? 'goal', path: e.path }]
          : e.type === 'outbound'
            ? [{ ts: e.ts, kind: 'outbound', to: e.name ?? '' }]
            : [],
    ),
    ...p.payments.map((x) => ({ ts: x.ts, kind: 'payment' as const, payment: x })),
  ];
  // Arrival first when it shares a timestamp with the first pageview.
  raw.sort((a, b) => a.ts - b.ts || (a.kind === 'arrive' ? -1 : b.kind === 'arrive' ? 1 : 0));

  const byDay = new Map<string, Item[]>();
  for (const it of raw) {
    const key = dayInTz(it.ts, tz);
    const list = byDay.get(key) ?? [];
    const prev = list.at(-1);
    if (it.kind === 'page' && prev?.kind === 'page' && prev.path === it.path) prev.times += 1;
    else list.push(it.kind === 'page' ? { ...it } : it);
    byDay.set(key, list);
  }
  const days = [...byDay.values()].map((items): [number, Item[]] => [items[0].ts, newestFirst ? [...items].reverse() : items]);
  return newestFirst ? days.reverse() : days;
}

function describe(it: Item, domain: string, money: (minor: number, compact?: boolean) => string): { node: ReactNode; text: string; icon: ReactNode; tone: string } {
  const muted = 'bg-stone-100 text-stone-500';
  switch (it.kind) {
    case 'arrive': {
      const s = it.session;
      const direct = /^direct/i.test(s.source);
      const extra = s.utm_campaign ? ` (campaign ${s.utm_campaign})` : s.ref ? ` (ref ${s.ref})` : '';
      return {
        text: direct ? `Came to ${domain} directly${extra}` : `Found ${domain} via ${s.source}${extra}`,
        node: (
          <span className="inline-flex items-center gap-1.5">
            {direct ? 'Came to' : 'Found'} <code className="text-[13px] font-medium">{domain}</code>
            {direct ? (
              ' directly'
            ) : (
              <>
                via <SourceIcon source={s.source} domain={s.referrer_domain} size={14} />
                <span className="font-medium">{s.source}</span>
              </>
            )}
            {extra && <span className="text-stone-400">{extra}</span>}
          </span>
        ),
        icon: <Glyph d="M11 4a7 7 0 1 0 4.5 12.4L20 21M11 4a7 7 0 0 1 4.5 12.4" />,
        tone: 'bg-visitorsSoft text-visitors',
      };
    }
    case 'page':
      return {
        text: `Viewed ${it.path}${it.times > 1 ? ` (${it.times} times)` : ''}`,
        node: (
          <>
            Viewed <code className="text-[13px] font-medium">{it.path}</code>
            {it.times > 1 && <span className="ml-1.5 text-stone-400">{it.times} times</span>}
          </>
        ),
        icon: <Glyph d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
        tone: muted,
      };
    case 'goal':
      return {
        text: `Completed ${it.name} on ${it.path}`,
        node: (
          <>
            Completed <span className="font-medium">{it.name}</span> <span className="text-stone-400">on {it.path}</span>
          </>
        ),
        icon: <Glyph d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-3a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />,
        tone: 'bg-violet-50 text-violet-700',
      };
    case 'outbound': {
      const to = it.to.replace(/^https?:\/\/(www\.)?/, '');
      return {
        text: `Left for ${to}`,
        node: (
          <>
            Left for <span className="font-medium">{to}</span>
          </>
        ),
        icon: <Glyph d="M7 17 17 7M8 7h9v9" />,
        tone: muted,
      };
    }
    case 'payment': {
      const x = it.payment;
      const refund = x.kind === 'refund';
      const charged = fmtCharged(x.original_amount, x.original_currency);
      return {
        text: `${refund ? 'Refunded' : x.renewal ? 'Renewed for' : 'Paid'} ${money(Math.abs(x.amount))}${charged ? ` (${charged})` : ''}`,
        node: (
          <span className="font-medium">
            {refund ? 'Refunded' : x.renewal ? 'Renewed for' : 'Paid'} {money(Math.abs(x.amount))}
            {charged && <span className="ml-1 font-normal text-stone-400">({charged})</span>}
          </span>
        ),
        icon: <Glyph d="M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.7 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3" />,
        tone: refund ? 'bg-red-50 text-red-600' : 'bg-revenueSoft text-ink',
      };
    }
  }
}

/** Every day of the last WEEKS weeks as a square, darker the more the visitor did that day. */
function Heatmap({ p, tz }: { p: Profile; tz: string }) {
  const counts = new Map<string, number>();
  for (const e of p.events) counts.set(dayInTz(e.ts, tz), (counts.get(dayInTz(e.ts, tz)) ?? 0) + 1);
  for (const x of p.payments) counts.set(dayInTz(x.ts, tz), (counts.get(dayInTz(x.ts, tz)) ?? 0) + 3);

  // Columns are weeks (oldest on the left), rows are days Sunday→Saturday, ending with today's week.
  const today = new Date(dayInTz(Date.now(), tz) + 'T00:00:00Z');
  // The Sunday that starts the oldest week shown.
  const start = new Date(today.getTime() - (today.getUTCDay() + (WEEKS - 1) * 7) * DAY);
  const weeks: { key: string; n: number; future: boolean }[][] = [];
  const months: { col: number; label: string }[] = [];
  for (let w = 0; w < WEEKS; w++) {
    const col: { key: string; n: number; future: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getTime() + (w * 7 + d) * DAY);
      const key = date.toISOString().slice(0, 10);
      col.push({ key, n: counts.get(key) ?? 0, future: date > today });
      const label = date.toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
      // A label where each month's first week starts, never twice in a row or crowding the next one.
      if (d === 0 && label !== months.at(-1)?.label && (date.getUTCDate() <= 7 || w === 0) && w < WEEKS - 2) months.push({ col: w, label });
    }
    weeks.push(col);
  }
  if (months.length > 1 && months[1].col - months[0].col < 3) months.shift();
  const level = (n: number) => (n === 0 ? 'bg-stone-100' : n < 3 ? 'bg-visitors/30' : n < 8 ? 'bg-visitors/60' : 'bg-visitors');

  return (
    <div className="mt-3">
      {/* Columns share the width, so the map always fits its panel; each square stays square. */}
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}>
        {weeks.map((col, w) => (
          <div key={w} className="grid gap-[3px]">
            {col.map((c) => (
              <span
                key={c.key}
                className={`aspect-square w-full rounded-[2px] ${c.future ? 'bg-transparent' : level(c.n)}`}
                title={c.future ? undefined : `${c.key}: ${c.n ? `${c.n} action${c.n === 1 ? '' : 's'}` : 'nothing'}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] text-stone-400">
        {months.map((m) => (
          <span key={m.col} className="absolute" style={{ left: `${(m.col / WEEKS) * 100}%` }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-stone-400">
        Less
        {[0, 1, 4, 9].map((n) => (
          <span key={n} className={`h-2.5 w-2.5 rounded-[2px] ${level(n)}`} />
        ))}
        More
      </div>
    </div>
  );
}

function daysBetween(from: number, to: number) {
  const d = Math.floor((to - from) / DAY);
  return d <= 0 ? '<1 day' : `${d} day${d === 1 ? '' : 's'}`;
}

function Glyph({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 text-stone-700">
      <span className="flex w-5 justify-center">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </li>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-stone-500">{label}</dt>
      <dd className={`min-w-0 truncate ${mono ? 'font-mono text-[12px]' : 'font-medium'}`}>{value}</dd>
    </div>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-surface px-2 py-3">
      <div className={`num truncate text-lg font-semibold leading-tight ${accent ? 'text-revenue' : ''}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-stone-500">{label}</div>
    </div>
  );
}
