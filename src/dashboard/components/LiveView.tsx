import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { persona } from '../../shared/names';
import { api } from '../lib/api';
import { countryName, flag, fmtAgo } from '../lib/format';
import { playVisitor, unlockAudio } from '../lib/sounds';
import { BrowserIcon, DeviceIcon, Favicon, Flag, OSIcon, SourceIcon } from './Icons';

/** Someone on the site right now. Only where they are and what they're doing: no names, no money. */
interface LiveVisitor {
  visitor_id: string;
  lat: number | null;
  lon: number | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  source: string;
  referrer_domain: string | null;
  page: string | null;
  started_at: number;
  last_seen_at: number;
  /** Their last page view or goal: what decides whether they still count as live. */
  last_active_at?: number;
  pageviews: number;
}

interface FeedItem {
  id: string;
  ts: number;
  type: 'pageview' | 'goal' | 'payment' | 'refund';
  label?: string;
  visitor_id: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
}

interface Realtime {
  visitors: LiveVisitor[];
  feed: FeedItem[];
}

export interface LiveSite {
  id: string;
  name: string;
  domain: string;
}

// Free vector tiles from OpenFreeMap (no account or API key).
const STYLE = 'https://tiles.openfreemap.org/styles/dark';
const POLL_MS = 5000;
const SPIN_IDLE_MS = 8000;
/** Live = opened a page or completed a goal in the last 10 minutes (matches the server's ONLINE_MS). */
const ACTIVE_MS = 10 * 60_000;

function pref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function counts(items: (string | null)[]): [string, number][] {
  const m = new Map<string, number>();
  for (const i of items) if (i) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** "Visitor from Ludhiana", never a name. */
const whoFrom = (v: { city?: string | null; country: string | null }) =>
  `Visitor from ${v.city || countryName(v.country) || 'somewhere'}`;

/**
 * A clean map: English place names only (the dark style otherwise prints every label twice, in Latin and
 * local script), and only places and water, no roads, shops or house numbers.
 */
function simplifyStyle(map: maplibregl.Map) {
  const english = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== 'symbol') continue;
    const keep = /place|country|continent|state|city|town|water|ocean|sea|marine/i.test(layer.id) && !/village|hamlet|suburb|neighbo|island_point/i.test(layer.id);
    if (!keep) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
      continue;
    }
    if (JSON.stringify(map.getLayoutProperty(layer.id, 'text-field') ?? '').includes('name')) {
      map.setLayoutProperty(layer.id, 'text-field', english as maplibregl.ExpressionSpecification);
    }
  }
  // A soft blue atmosphere around the globe, against the starfield behind the map.
  try {
    map.setSky({
      'sky-color': '#0b1b4a',
      'horizon-color': '#2c5bd8',
      'fog-color': '#0b1b4a',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.8,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
    } as maplibregl.SkySpecification);
  } catch {}
}

/** A pin: the visitor's avatar in a bubble with a tail, and a pulse ring while they're active. */
function pinElement(v: LiveVisitor, onClick: () => void): HTMLElement {
  const p = persona(v.visitor_id);
  // Built with DOM calls rather than an HTML string: nothing from the visitor's data is parsed as markup,
  // and colours set through .style are allowed by the page's Content-Security-Policy (style attributes aren't).
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) => Object.assign(document.createElement(tag), { className: cls });
  const wrap = el('div', 'ml-pin');
  const pulse = el('span', 'ml-pin-pulse');
  pulse.style.background = p.color;
  const head = el('button', 'ml-pin-head');
  head.style.background = p.color;
  head.title = whoFrom(v);
  const img = el('img', '');
  img.src = p.avatar;
  img.alt = '';
  head.appendChild(img);
  for (const part of [pulse, head, el('span', 'ml-pin-tail')]) wrap.appendChild(part);
  head.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return wrap;
}

/**
 * The real-time map page: everyone on the site in the last few minutes, pinned where they are, with a
 * feed of the pages they open. Nothing about money and no visitor names: just where and what.
 */
export default function LiveView({ site, base, onClose }: { site: LiveSite; base: string; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const known = useRef<Set<string> | null>(null);
  const interacting = useRef(0);

  const [data, setData] = useState<Realtime | null>(null);
  const [error, setError] = useState('');
  const [projection, setProjection] = useState(() => pref('ml_live_projection', 'globe') as 'globe' | 'mercator');
  const [sound, setSound] = useState(() => pref('ml_live_sound', 'off') === 'on');
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<LiveVisitor | null>(null);
  const [, tick] = useState(0);

  // ---- data
  const load = useCallback(async () => {
    try {
      const d = await api<Realtime>(`${base}/${site.id}/realtime`);
      const ids = new Set(d.visitors.map((v) => v.visitor_id));
      if (known.current && soundRef.current && [...ids].some((id) => !known.current!.has(id))) playVisitor();
      known.current = ids;
      // Pages and goals only: payments and refunds don't belong on this map.
      setData({ visitors: d.visitors, feed: d.feed.filter((f) => f.type === 'pageview' || f.type === 'goal') });
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [site.id, base]);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
      tick((n) => n + 1);
    }, POLL_MS);
    // Polling pauses in a background tab; coming back must show now, not what was live when you left.
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const projectionRef = useRef(projection);
  projectionRef.current = projection;

  // ---- map
  useEffect(() => {
    if (!mapEl.current) return;
    const map = new maplibregl.Map({
      container: mapEl.current,
      style: STYLE,
      center: [60, 22],
      zoom: 1.6,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.on('style.load', () => {
      try {
        map.setProjection({ type: projectionRef.current });
      } catch {}
      simplifyStyle(map);
    });
    const touched = () => (interacting.current = Date.now());
    map.on('mousedown', touched);
    map.on('touchstart', touched);
    map.on('wheel', touched);
    map.on('click', () => setSelected(null));

    // A slow spin while nobody's touching it.
    let raf = 0;
    const spin = () => {
      if (projectionRef.current === 'globe' && Date.now() - interacting.current > SPIN_IDLE_MS && !map.isMoving()) {
        const c = map.getCenter();
        map.setCenter([c.lng + 0.035, c.lat]);
      }
      raf = requestAnimationFrame(spin);
    };
    raf = requestAnimationFrame(spin);
    return () => {
      cancelAnimationFrame(raf);
      markers.current.forEach((m) => m.remove());
      markers.current.clear();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    savePref('ml_live_projection', projection);
    try {
      if (mapRef.current?.isStyleLoaded()) mapRef.current.setProjection({ type: projection });
    } catch {}
  }, [projection]);
  useEffect(() => savePref('ml_live_sound', sound ? 'on' : 'off'), [sound]);

  const select = useCallback((v: LiveVisitor) => {
    interacting.current = Date.now();
    setSelected(v);
    if (v.lat !== null && v.lon !== null) {
      mapRef.current?.flyTo({ center: [v.lon, v.lat], zoom: Math.max(mapRef.current.getZoom(), 3.2), duration: 1400 });
    }
  }, []);

  // ---- one pin per visitor
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;
    const live = new Set<string>();
    for (const v of data.visitors) {
      if (v.lat === null || v.lon === null) continue;
      live.add(v.visitor_id);
      const existing = markers.current.get(v.visitor_id);
      if (existing) existing.setLngLat([v.lon, v.lat]);
      else {
        const m = new maplibregl.Marker({ element: pinElement(v, () => select(v)), anchor: 'bottom' }).setLngLat([v.lon, v.lat]).addTo(map);
        markers.current.set(v.visitor_id, m);
      }
    }
    for (const [id, m] of markers.current) {
      if (!live.has(id)) {
        m.remove();
        markers.current.delete(id);
      }
    }
  }, [data, select]);

  useEffect(() => {
    for (const [id, m] of markers.current) m.getElement().classList.toggle('is-active', id === selected?.visitor_id);
  }, [selected, data]);

  // ---- keyboard: Esc closes the card, then the page
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.fullscreenElement) return;
      if (selected) setSelected(null);
      else onClose();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose, selected]);

  // Re-checked against this browser's clock on every tick, so nobody idle for 10+ minutes lingers on the
  // map even if a refresh is late.
  const cutoff = Date.now() - ACTIVE_MS;
  const visitors = (data?.visitors ?? []).filter((v) => (v.last_active_at ?? v.last_seen_at) > cutoff);
  const recentFeed = (data?.feed ?? []).filter((f) => f.ts > cutoff);
  const groups = useMemo(
    () => [
      { key: 'referrers', label: 'Referrers', rows: counts(visitors.map((v) => v.source)), icon: (k: string) => <SourceIcon source={k} size={14} />, name: (k: string) => k },
      { key: 'countries', label: 'Countries', rows: counts(visitors.map((v) => v.country)), icon: (k: string) => <Flag cc={k} size={14} />, name: (k: string) => countryName(k) },
      { key: 'devices', label: 'Devices', rows: counts(visitors.map((v) => v.device)), icon: (k: string) => <DeviceIcon name={k} size={14} />, name: (k: string) => k },
    ],
    [visitors],
  );
  const unplaced = visitors.filter((v) => v.lat === null).length;

  const card = selected ? (visitors.find((v) => v.visitor_id === selected.visitor_id) ?? selected) : null;
  const cardOnline = !!card && visitors.some((v) => v.visitor_id === card.visitor_id);
  const cardActivity = card ? recentFeed.filter((f) => f.visitor_id === card.visitor_id).slice(0, 8) : [];

  const panel = 'rounded-2xl border border-white/10 bg-[#141414]/85 text-neutral-100 shadow-2xl backdrop-blur-md';
  const iconBtn = 'flex h-8 w-8 items-center justify-center rounded-lg text-neutral-300 transition hover:bg-white/10 hover:text-white';

  return (
    <div ref={rootRef} className="ml-stars fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0">
        <div ref={mapEl} className="h-full w-full" />
      </div>

      {/* Site, visitor count, controls, and what the people on the map have in common */}
      <div className={`absolute left-4 top-4 w-[min(340px,calc(100%-32px))] p-4 ${panel}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">
            <Favicon domain={site.domain} size={18} />
            <span className="truncate">{site.name}</span>
          </div>
          <div className="flex shrink-0 items-center">
            <button
              className={iconBtn}
              title={sound ? 'Sound on: a chime for each new visitor' : 'Sound off'}
              onClick={() => {
                unlockAudio();
                setSound((s) => !s);
              }}
            >
              {sound ? '🔔' : '🔕'}
            </button>
            <button className={`${iconBtn} text-[11px] font-bold`} title="3D globe / flat map" onClick={() => setProjection((p) => (p === 'globe' ? 'mercator' : 'globe'))}>
              {projection === 'globe' ? '2D' : '3D'}
            </button>
            <button className={iconBtn} title="Fullscreen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : rootRef.current?.requestFullscreen())}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            </button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 text-sm text-neutral-300">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
          </span>
          <b className="text-white">{visitors.length}</b> visitor{visitors.length === 1 ? '' : 's'} on <span className="truncate font-medium text-white">{site.domain}</span>
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">Active in the last 10 minutes</p>
        <div className="mt-3 border-t border-white/10 pt-1">
          {groups.map((g) => (
            <div key={g.key}>
              <button
                className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-left text-sm text-neutral-300 hover:text-white"
                onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}
              >
                <span>{g.label}</span>
                <span className="flex items-center gap-2 text-xs text-neutral-500">
                  {g.rows.length > 0 && g.rows.length}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition ${open[g.key] ? 'rotate-180' : ''}`}>
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </span>
              </button>
              {open[g.key] && (
                <ul className="mb-1 space-y-1 px-1 text-[13px]">
                  {g.rows.length === 0 && <li className="text-neutral-500">Nobody right now</li>}
                  {g.rows.map(([k, n]) => (
                    <li key={k} className="flex items-center gap-2">
                      {g.icon(k)}
                      <span className="min-w-0 flex-1 truncate">{g.name(k)}</span>
                      <span className="text-neutral-400">{n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        {unplaced > 0 && <p className="mt-1 text-[11px] text-neutral-500">{unplaced} without a known location, so not pinned.</p>}
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>

      <button className={`absolute right-4 top-4 ${iconBtn} h-10 w-10 bg-black/30`} title="Close (Esc)" onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>

      {/* The visitor you clicked: where they are, how they got here, and what they've opened */}
      {card && (
        <div className={`absolute left-4 right-4 top-16 z-10 max-h-[calc(100%-96px)] overflow-y-auto p-4 sm:left-auto sm:w-[330px] ${panel}`}>
          <div className="flex items-start gap-3">
            <img src={persona(card.visitor_id).avatar} alt="" className="h-10 w-10 shrink-0 rounded-full" style={{ background: persona(card.visitor_id).color }} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{whoFrom(card)}</div>
              <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                {cardOnline ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" /> On the site now
                  </>
                ) : (
                  'Left the site'
                )}
              </div>
            </div>
            <button className={iconBtn} title="Close (Esc)" onClick={() => setSelected(null)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <dl className="mt-3 space-y-1.5 text-[13px]">
            <Row label="Location">
              <Item icon={<Flag cc={card.country} size={14} />}>{[card.city, card.region, countryName(card.country)].filter(Boolean).join(', ') || 'Unknown'}</Item>
            </Row>
            <Row label="Came from">
              <Item icon={<SourceIcon source={card.source} domain={card.referrer_domain} size={14} />}>{card.source}</Item>
            </Row>
            <Row label="Device">
              <Item icon={<DeviceIcon name={card.device} size={14} />}>{card.device}</Item>
              <Item icon={<OSIcon name={card.os} size={14} />}>{card.os}</Item>
              <Item icon={<BrowserIcon name={card.browser} size={14} />}>{card.browser}</Item>
            </Row>
            <Row label="Now on">
              <code className="break-all font-medium">{card.page ?? '/'}</code>
            </Row>
            <Row label="This visit">
              {card.pageviews} page{card.pageviews === 1 ? '' : 's'} · {fmtAgo(card.last_seen_at - card.started_at) || 'just arrived'}
            </Row>
            <Row label="Last active">{fmtAgo(Date.now() - (card.last_active_at ?? card.last_seen_at)) || 'now'} ago</Row>
          </dl>
          <div className="mt-3 border-t border-white/10 pt-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">What they did</div>
          {cardActivity.length === 0 && <p className="mt-1 text-xs text-neutral-500">Nothing in the last 10 minutes.</p>}
          <ol className="mt-1 space-y-1">
            {cardActivity.map((f) => (
              <li key={f.id} className="flex items-start gap-2 text-[13px]">
                <span className="shrink-0">{f.type === 'goal' ? '🎯' : '👁'}</span>
                <span className="min-w-0 flex-1 truncate">{f.type === 'goal' ? <span className="text-violet-300">{f.label}</span> : <code>{f.label}</code>}</span>
                <span className="shrink-0 text-[11px] text-neutral-500">{fmtAgo(Date.now() - f.ts)} ago</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* What's happening, newest first */}
      <div className={`absolute bottom-4 left-4 max-h-[38vh] w-[min(360px,calc(100%-32px))] overflow-y-auto p-2 ${panel}`}>
        {!data && <p className="p-4 text-center text-sm text-neutral-400">Connecting…</p>}
        {data && recentFeed.length === 0 && <p className="p-4 text-center text-sm text-neutral-400">Waiting for events…</p>}
        {recentFeed.map((f) => {
          const v = visitors.find((x) => x.visitor_id === f.visitor_id);
          return (
            <button
              key={f.id}
              onClick={() => v && select(v)}
              className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] leading-snug hover:bg-white/10 ${
                f.visitor_id && f.visitor_id === selected?.visitor_id ? 'bg-white/10' : ''
              }`}
            >
              {f.visitor_id ? (
                <img src={persona(f.visitor_id).avatar} alt="" className="mt-0.5 h-6 w-6 shrink-0 rounded-full" style={{ background: persona(f.visitor_id).color }} />
              ) : (
                <span className="mt-0.5 h-6 w-6 shrink-0" />
              )}
              <span className="min-w-0">
                <span className="text-neutral-300">
                  {v ? whoFrom(v) : f.country ? `A visitor from ${countryName(f.country)}` : 'A visitor'} {f.country && <>{flag(f.country)} </>}
                </span>
                {f.type === 'goal' ? (
                  <>
                    completed <span className="font-medium text-violet-300">{f.label}</span>
                  </>
                ) : (
                  <>
                    opened <code className="font-medium text-white">{f.label}</code>
                  </>
                )}
                <span className="block text-[11px] text-neutral-500">{fmtAgo(Date.now() - f.ts)} ago</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <dt className="w-20 shrink-0 text-neutral-500">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-1">{children}</dd>
    </div>
  );
}

function Item({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </span>
  );
}
