import { BRAND } from '../lib/brand';

/** The mark: an open ring with a visitor arriving through the gap. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <path d="M24.69 13.67A9 9 0 1 1 18.33 7.31" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="22.6" cy="9.4" r="2.6" className="fill-visitors" />
    </svg>
  );
}

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className="flex items-center gap-2 text-ink">
      <Mark size={small ? 22 : 26} />
      <span className={`font-semibold tracking-tight ${small ? 'text-[15px]' : 'text-base'}`}>{BRAND}</span>
    </span>
  );
}
