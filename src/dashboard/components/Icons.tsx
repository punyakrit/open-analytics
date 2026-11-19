import { useState, type ReactNode } from 'react';
import { persona } from '../../shared/names';
import { domainForSource } from '../../shared/sources';
import { flag } from '../lib/format';

export function Favicon({ domain, size = 18, fallback }: { domain?: string | null; size?: number; fallback?: string }) {
  const [broken, setBroken] = useState(false);
  if (!domain || broken) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded text-stone-400"
        style={{ width: size, height: size, fontSize: size * 0.8 }}
      >
        {fallback ?? <LinkIcon size={size} />}
      </span>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
      width={size}
      height={size}
      className="shrink-0 rounded"
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

/** The settings cog: opens a site's settings (install, payments, sharing). */
export function GearIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function LinkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

export function SourceIcon({ source, domain, size }: { source: string | null; domain?: string | null; size?: number }) {
  if (!source || source === 'Direct/None') return <Favicon size={size} />;
  return <Favicon domain={domainForSource(source) ?? domain ?? (source.includes('.') ? source : null)} size={size} />;
}

const CHANNEL_EMOJI: Record<string, string> = {
  Direct: '🔗',
  'Organic Search': '🔎',
  'Organic Social': '💬',
  AI: '✨',
  Referral: '↗️',
  Email: '✉️',
  Paid: '💸',
};
export function ChannelIcon({ channel }: { channel: string | null }) {
  return <Favicon fallback={CHANNEL_EMOJI[channel ?? ''] ?? '•'} />;
}

const BROWSER_DOMAINS: Record<string, string> = {
  Chrome: 'google.com/chrome',
  'Chrome WebView': 'android.com',
  Safari: 'apple.com/safari',
  'Mobile Safari': 'apple.com/safari',
  Firefox: 'firefox.com',
  Edge: 'microsoft.com/edge',
  Opera: 'opera.com',
  'Samsung Internet': 'samsung.com',
  Brave: 'brave.com',
  Arc: 'arc.net',
  Vivaldi: 'vivaldi.com',
  Yandex: 'browser.yandex.com',
  DuckDuckGo: 'duckduckgo.com',
  Instagram: 'instagram.com',
  Facebook: 'facebook.com',
  Twitter: 'x.com',
  LinkedIn: 'linkedin.com',
  Threads: 'threads.net',
  TikTok: 'tiktok.com',
  WebKit: 'webkit.org',
};
const OS_DOMAINS: Record<string, string> = {
  'Mac OS': 'apple.com',
  iOS: 'apple.com',
  iPadOS: 'apple.com',
  Windows: 'microsoft.com',
  Android: 'android.com',
  Linux: 'kernel.org',
  'Chrome OS': 'chromeos.google',
};

export function BrowserIcon({ name, size }: { name: string | null; size?: number }) {
  return <Favicon domain={name ? BROWSER_DOMAINS[name] : null} size={size} fallback="🌐" />;
}
export function OSIcon({ name, size }: { name: string | null; size?: number }) {
  return <Favicon domain={name ? OS_DOMAINS[name] : null} size={size} fallback="💻" />;
}
export function DeviceIcon({ name, size = 18 }: { name: string | null; size?: number }) {
  return <Favicon size={size} fallback={name === 'Mobile' ? '📱' : name === 'Tablet' ? '📲' : '🖥️'} />;
}
export function Flag({ cc, size = 18 }: { cc: string | null; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size, fontSize: size * 0.9 }}>
      {flag(cc)}
    </span>
  );
}

/** A friendly, stable avatar per visitor (same visitor id = same face and animal name). */
export function Avatar({ id, size = 40 }: { id: string; size?: number }) {
  const p = persona(id);
  return (
    <img
      src={p.avatar}
      alt=""
      title={p.name}
      width={size}
      height={size}
      className="inline-block shrink-0 rounded-full ring-2 ring-surface"
      style={{ width: size, height: size, background: p.color }}
    />
  );
}

// ---------- interface icons (24px grid, 1.8 stroke, currentColor)

function Line({ size = 18, children, strokeWidth = 1.8 }: { size?: number; children: ReactNode; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
export const SunIcon = ({ size }: { size?: number }) => (
  <Line size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Line>
);
export const MoonIcon = ({ size }: { size?: number }) => (
  <Line size={size}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Line>
);
export const PlusIcon = ({ size }: { size?: number }) => (
  <Line size={size} strokeWidth={2}>
    <path d="M12 5v14M5 12h14" />
  </Line>
);
export const RefreshIcon = ({ size, spinning = false }: { size?: number; spinning?: boolean }) => (
  <span className={`inline-flex ${spinning ? 'animate-spin' : ''}`}>
    <Line size={size}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9L20 8.5" />
      <path d="M20 3.5v5h-5" />
    </Line>
  </span>
);
export const CloseIcon = ({ size }: { size?: number }) => (
  <Line size={size} strokeWidth={2}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Line>
);
export const ChevronDownIcon = ({ size = 14 }: { size?: number }) => (
  <Line size={size} strokeWidth={2}>
    <path d="m6 9 6 6 6-6" />
  </Line>
);
export const ChevronIcon = ({ size = 16, dir }: { size?: number; dir: 'left' | 'right' }) => (
  <Line size={size} strokeWidth={2}>
    <path d={dir === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
  </Line>
);
export const ArrowLeftIcon = ({ size }: { size?: number }) => (
  <Line size={size}>
    <path d="M19 12H5M11 18l-6-6 6-6" />
  </Line>
);
export const GlobeIcon = ({ size }: { size?: number }) => (
  <Line size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" />
  </Line>
);
export const LogOutIcon = ({ size }: { size?: number }) => (
  <Line size={size}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />
  </Line>
);
export const CheckIcon = ({ size }: { size?: number }) => (
  <Line size={size} strokeWidth={2.2}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Line>
);
export const CopyIcon = ({ size }: { size?: number }) => (
  <Line size={size}>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Line>
);
export const BellIcon = ({ size }: { size?: number }) => (
  <Line size={size}>
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10.3 20a2 2 0 0 0 3.4 0" />
  </Line>
);
