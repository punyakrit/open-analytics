/**
 * "Live payments" in the dashboard: called every 20 seconds while it's switched on, and by "Check now".
 *
 * Sites connected to Dodo by API key normally pick up new payments every 10 minutes; here they're pulled
 * straight away (at most every SYNC_GAP_MS per site, so a few open tabs don't flood Dodo with requests).
 * Webhook and API payments are already in the database the moment they happen.
 *
 * Then it returns the payments saved since the caller's cursor. The cursor is the row order payments were
 * saved in, not their payment time: a Dodo payment can be saved minutes after it happened, and a time-based
 * cursor would skip it. Saving a payment again updates its row in place, so it never comes back as new.
 */
import type { Context } from 'hono';
import { siteAccessSql } from './auth';
import { syncDodo } from './dodo';
import type { AppEnv, Site } from './env';

const SYNC_GAP_MS = 15_000;
const MAX_RETURNED = 20;

export interface NewPayment {
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

export async function checkPayments(c: Context<AppEnv>) {
  const body = await c.req.json<{ cursor?: unknown; site?: unknown }>().catch(() => ({}) as { cursor?: unknown; site?: unknown });
  const only = typeof body.site === 'string' ? body.site : null;
  const access = siteAccessSql(c.env, c.get('user'));
  const sites = (
    await c.env.DB.prepare(`SELECT s.* FROM sites s WHERE ${access.sql}${only ? ' AND s.id = ?' : ''}`)
      .bind(...access.params, ...(only ? [only] : []))
      .all<Site>()
  ).results;
  const checkedAt = Date.now();
  if (!sites.length) return c.json({ cursor: 0, payments: [], checked_at: checkedAt });

  const due = sites.filter((s) => s.dodo_api_key && s.dodo_brand_id && (!s.dodo_synced_at || s.dodo_synced_at < checkedAt - SYNC_GAP_MS));
  // A failed sync is already recorded on the site (Settings shows it); the check still answers.
  await Promise.allSettled(due.map((s) => syncDodo(c.env, s)));

  const ids = sites.map((s) => s.id);
  const marks = ids.map(() => '?').join(', ');
  const cursor = typeof body.cursor === 'number' && Number.isFinite(body.cursor) ? body.cursor : null;
  const latest = await c.env.DB.prepare(`SELECT COALESCE(MAX(rowid), 0) AS seq FROM payments WHERE site_id IN (${marks})`)
    .bind(...ids)
    .first<{ seq: number }>();
  const seq = latest?.seq ?? 0;
  // First call: just learn where "now" is, so payments from before the switch was turned on don't celebrate.
  if (cursor === null || cursor >= seq) return c.json({ cursor: Math.max(seq, cursor ?? 0), payments: [], checked_at: checkedAt, synced: due.length });

  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.site_id, p.ts, p.amount, p.currency, p.renewal, p.name, p.email, p.visitor_id, s.source, s.utm_campaign AS campaign
     FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
     WHERE p.site_id IN (${marks}) AND p.rowid > ? AND p.rowid <= ? AND p.kind = 'payment' AND p.amount > 0
     ORDER BY p.rowid DESC LIMIT ${MAX_RETURNED}`,
  )
    .bind(...ids, cursor, seq)
    .all<NewPayment>();
  return c.json({ cursor: seq, payments: rows.results.reverse(), checked_at: checkedAt, synced: due.length });
}
