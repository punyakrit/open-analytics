/**
 * Dodo Payments through its API, as an alternative to the webhook: the owner pastes an API key, picks
 * which of the business's brands is this site, and the Worker pulls that brand's payments and refunds
 * every 10 minutes (cron in wrangler.jsonc) and on "Sync now". Payments land through the same code as
 * webhook deliveries (payments.ts), and recording is idempotent by payment id, so running both is safe.
 *
 * A read-only key is enough: Read access to Brands, Payments and Refunds.
 */
import type { Env, Site } from './env';
import { forgetSite } from './env';
import { decryptSecret } from './lib/crypto';
import { tzOffset } from './lib/time';
import { dodoPaymentInput, recordDodoRefund, recordPayment } from './payments';

const HOSTS = { live: 'https://live.dodopayments.com', test: 'https://test.dodopayments.com' } as const;
export type DodoMode = keyof typeof HOSTS;

/** Dodo prefixes keys with their mode; older unprefixed keys are live keys more often than not. */
export const modeOfKey = (key: string): DodoMode => (key.startsWith('dodo_test_') ? 'test' : 'live');

export class DodoError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function dodo(env: Env, key: string, mode: DodoMode, path: string, params: Record<string, string | number | undefined> = {}) {
  // DODO_API_BASE exists only so local tests can point at a stand-in server.
  const url = new URL((env.DODO_API_BASE || HOSTS[mode]) + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  if (res.ok) return res.json<any>();
  const body = await res.text().catch(() => '');
  if (res.status === 401) throw new DodoError(401, 'Dodo rejected this API key. Check it is the right key for this business (live keys start dodo_live_, test keys dodo_test_).');
  if (res.status === 403) {
    if (body.includes('IP_ADDRESS_NOT_ALLOWED')) throw new DodoError(403, "This key only works from allow-listed IPs, and Cloudflare's aren't on the list. Use a key without an IP allowlist.");
    throw new DodoError(403, 'This key lacks Read access to Brands, Payments or Refunds. Create a key with Read access to those three.');
  }
  if (res.status === 429) throw new DodoError(429, 'Dodo is rate-limiting requests right now; the next sync will catch up.');
  throw new DodoError(res.status, `Dodo answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
}

export interface DodoBrand {
  brand_id: string;
  name: string | null;
  url: string | null;
  statement_descriptor: string;
}

export async function listBrands(env: Env, key: string, mode: DodoMode): Promise<DodoBrand[]> {
  const r = await dodo(env, key, mode, '/brands');
  return ((r?.items ?? []) as any[]).map((b) => ({
    brand_id: String(b.brand_id),
    name: b.name ?? null,
    url: b.url ?? null,
    statement_descriptor: String(b.statement_descriptor ?? ''),
  }));
}

export async function storedKey(env: Env, site: Site): Promise<string | null> {
  return site.dodo_api_key ? decryptSecret(env.SESSION_SECRET, site.dodo_api_key) : null;
}

/**
 * Where a brand's payments start being pulled. A site with imported history (DataFast) starts the day after
 * it ends, because that history already holds those days' revenue. Otherwise, the last 90 days.
 */
export async function defaultSyncFrom(env: Env, site: Site): Promise<number> {
  const row = await env.DB.prepare('SELECT MAX(day) AS last FROM imported_daily WHERE site_id = ?').bind(site.id).first<{ last: string | null }>();
  if (row?.last) {
    const nextDayUtc = Date.parse(row.last + 'T00:00:00Z') + 86_400_000;
    return nextDayUtc - tzOffset(site.timezone, nextDayUtc);
  }
  return Date.now() - 90 * 86_400_000;
}

const PAGE = 100;
const MAX_PAGES = 20; // up to 2,000 payments a run: far beyond a normal 10 minutes, inside the Worker's request budget
const OVERLAP_MS = 2 * 3_600_000; // each run re-reads the last 2 hours, so a payment listed late is never missed

export interface SyncResult {
  payments: number;
  refunds: number;
}

/** Pull this site's brand's new payments and refunds. Records progress or the error on the site row. */
export async function syncDodo(env: Env, site: Site): Promise<SyncResult> {
  const started = Date.now();
  const setStatus = (error: string | null, synced: boolean) =>
    env.DB.prepare(`UPDATE sites SET dodo_sync_error = ?${synced ? ', dodo_synced_at = ?' : ''} WHERE id = ?`)
      .bind(...(synced ? [error, started, site.id] : [error, site.id]))
      .run()
      .then(() => forgetSite(site.id));
  try {
    const key = await storedKey(env, site);
    if (!key) throw new DodoError(400, 'The saved Dodo key can no longer be read (the server secret changed). Paste the key again.');
    if (!site.dodo_brand_id) throw new DodoError(400, 'Pick which Dodo brand is this website.');
    const mode: DodoMode = site.dodo_api_mode === 'test' ? 'test' : 'live';
    const since = new Date(Math.max(site.dodo_sync_from ?? 0, site.dodo_synced_at ? site.dodo_synced_at - OVERLAP_MS : 0)).toISOString();
    let payments = 0;
    let refunds = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await dodo(env, key, mode, '/payments', { brand_id: site.dodo_brand_id, status: 'succeeded', created_at_gte: since, page_size: PAGE, page_number: page });
      const items = (r?.items ?? []) as Record<string, any>[];
      // Skip payments already recorded (the 2-hour overlap, or the webhook got there first).
      const ids = items.map((p) => String(p.payment_id));
      const known = new Set<string>();
      if (ids.length) {
        const rows = await env.DB.prepare(`SELECT id FROM payments WHERE site_id = ? AND id IN (${ids.map(() => '?').join(', ')})`)
          .bind(site.id, ...ids)
          .all<{ id: string }>();
        for (const row of rows.results) known.add(row.id);
      }
      for (let data of items) {
        if (known.has(String(data.payment_id))) continue;
        // The list leaves out settlement amounts; only a payment in another currency needs its full record.
        if (String(data.currency ?? '').toUpperCase() !== site.currency) data = (await dodo(env, key, mode, `/payments/${encodeURIComponent(data.payment_id)}`)) ?? data;
        await recordPayment(env.DB, site, dodoPaymentInput(site, data, Date.parse(data.created_at ?? '') || started));
        payments++;
      }
      if (items.length < PAGE) break;
      if (page === MAX_PAGES - 1) throw new DodoError(413, `More than ${MAX_PAGES * PAGE} payments to catch up on; the next sync continues.`);
    }

    // Dodo can't filter refunds by brand, so take the succeeded ones and keep refunds of this site's payments.
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await dodo(env, key, mode, '/refunds', { status: 'succeeded', created_at_gte: since, page_size: PAGE, page_number: page });
      const items = (r?.items ?? []) as Record<string, any>[];
      for (const data of items) {
        const exists = await env.DB.prepare('SELECT 1 FROM payments WHERE id = ? AND site_id = ?').bind(String(data.refund_id), site.id).first();
        if (!exists && (await recordDodoRefund(env.DB, site, data, Date.parse(data.created_at ?? '') || started))) refunds++;
      }
      if (items.length < PAGE) break;
    }

    await setStatus(null, true);
    return { payments, refunds };
  } catch (e) {
    await setStatus((e as Error).message.slice(0, 300), false);
    throw e;
  }
}

/** The cron: every site with a Dodo key and a brand, one after another. One site's failure doesn't stop the rest. */
export async function syncAllDodo(env: Env) {
  const sites = await env.DB.prepare('SELECT * FROM sites WHERE dodo_api_key IS NOT NULL AND dodo_brand_id IS NOT NULL').all<Site>();
  for (const site of sites.results) {
    try {
      await syncDodo(env, site);
    } catch {
      // Already recorded on the site row, where the settings page shows it.
    }
  }
}
