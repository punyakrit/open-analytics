import { createContext, useContext } from 'react';
import type { Query, Site } from './api';

export interface Dash {
  site: Site;
  /** API prefix for this site's stats: `/api/sites` for the owner, `/api/public/sites` for a public viewer. */
  base: string;
  /** Public viewer: aggregate stats only, nothing that edits or shows individual visitors. */
  readOnly: boolean;
  q: Query;
  reloadKey: number;
  decimals: number;
  money: (minor: number, compact?: boolean) => string;
  addFilter: (key: string, value: string) => void;
  openVisitor: (visitorId: string) => void;
}

export const DashContext = createContext<Dash | null>(null);

export function useDash(): Dash {
  const d = useContext(DashContext);
  if (!d) throw new Error('useDash outside dashboard');
  return d;
}
