/**
 * Exchange rates, so revenue taken in several currencies adds up in the site's currency.
 *
 * Providers don't always say what a payment is worth in your currency: Dodo pays some countries out in their own
 * currency (a UK customer's £9.12 settles in pounds), Stripe webhooks carry the amount the customer was charged,
 * and the payments API takes any currency. Those are converted at the payment day's reference rate from the free
 * currency-api (github.com/fawazahmed0/exchange-api: no key, 300+ currencies, one file per day), fetched once per
 * day it's needed and kept in D1. The amount as charged is kept on the payment too.
 */
import { currencyDecimals } from '../shared/currency';

type Rates = Record<string, number>; // units per 1 USD, lowercase codes

const DAY_MS = 86_400_000;
const sources = (day: string) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.min.json`,
  `https://${day}.currency-api.pages.dev/v1/currencies/usd.min.json`,
];

async function ratesOn(db: D1Database, day: string): Promise<Rates | null> {
  const row = await db.prepare('SELECT rates FROM fx_rates WHERE day = ?').bind(day).first<{ rates: string }>();
  if (row) return JSON.parse(row.rates) as Rates;
  for (const url of sources(day)) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const body = await res.json<{ date?: string; usd?: Rates }>();
      if (!body?.usd || typeof body.usd.eur !== 'number') continue;
      await db.prepare('INSERT OR REPLACE INTO fx_rates (day, rates, fetched_at) VALUES (?, ?, ?)').bind(day, JSON.stringify(body.usd), Date.now()).run();
      return body.usd;
    } catch {
      // Try the mirror, then an earlier day.
    }
  }
  return null;
}

/** The rates of the payment's day, or the latest published before it (today's file can appear late in the day). */
async function ratesNear(db: D1Database, ts: number): Promise<Rates | null> {
  const t = Math.min(ts, Date.now());
  for (let back = 0; back < 4; back++) {
    const rates = await ratesOn(db, new Date(t - back * DAY_MS).toISOString().slice(0, 10));
    if (rates) return rates;
  }
  return null;
}

/** `amount` (minor units of `from`) in minor units of `to`, with the given rates; null when a currency is unknown. */
export function convertWith(rates: Rates, amount: number, from: string, to: string): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amount;
  const perUsdFrom = rates[f.toLowerCase()];
  const perUsdTo = rates[t.toLowerCase()];
  if (!(perUsdFrom > 0) || !(perUsdTo > 0)) return null;
  const major = amount / 10 ** currencyDecimals(f);
  return Math.round((major / perUsdFrom) * perUsdTo * 10 ** currencyDecimals(t));
}

/** Convert at the rate of the day `ts` falls on. null when the rates can't be had right now (tried again later). */
export async function convert(db: D1Database, amount: number, from: string, to: string, ts: number): Promise<number | null> {
  if (from.toUpperCase() === to.toUpperCase()) return amount;
  const rates = await ratesNear(db, ts);
  return rates ? convertWith(rates, amount, from, to) : null;
}

export interface Money {
  amount: number;
  currency: string;
  original_amount: number | null;
  original_currency: string | null;
}

/** A payment's amount as recorded: in the site's currency when it can be converted, the charged amount kept. */
export async function inSiteCurrency(db: D1Database, siteCurrency: string, amount: number, currency: string, ts: number): Promise<Money> {
  const cur = currency.toUpperCase();
  if (cur === siteCurrency) return { amount, currency: cur, original_amount: null, original_currency: null };
  const converted = await convert(db, amount, cur, siteCurrency, ts);
  if (converted === null) return { amount, currency: cur, original_amount: null, original_currency: null };
  return { amount: converted, currency: siteCurrency, original_amount: amount, original_currency: cur };
}

/**
 * A refund in the site's currency. A refund of a converted payment uses that payment's rate, so a full refund
 * cancels the payment exactly.
 */
export async function refundInSiteCurrency(
  db: D1Database,
  siteCurrency: string,
  refund: { amount: number; currency: string; ts: number },
  payment: { amount: number; currency: string; original_amount?: number | null; original_currency?: string | null },
): Promise<Money> {
  const cur = refund.currency.toUpperCase();
  if (cur !== siteCurrency && payment.currency === siteCurrency && payment.original_currency === cur && payment.original_amount) {
    const amount = Math.round(refund.amount * (payment.amount / payment.original_amount));
    return { amount, currency: siteCurrency, original_amount: refund.amount, original_currency: cur };
  }
  return inSiteCurrency(db, siteCurrency, refund.amount, cur, refund.ts);
}

/**
 * Convert payments still in another currency than their site's: recorded while the rates couldn't be fetched,
 * recorded before conversion existed, or the site's currency has changed since. Runs every 10 minutes, and for a
 * site right after its currency changes.
 */
export async function convertStoredPayments(db: D1Database, siteId?: string): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT p.site_id, p.id, p.ts, p.amount, p.currency, p.original_amount, p.original_currency, s.currency AS site_currency
       FROM payments p JOIN sites s ON s.id = p.site_id
       WHERE p.currency != s.currency${siteId ? ' AND p.site_id = ?' : ''} LIMIT 200`,
    )
    .bind(...(siteId ? [siteId] : []))
    .all<{ site_id: string; id: string; ts: number; amount: number; currency: string; original_amount: number | null; original_currency: string | null; site_currency: string }>();
  let converted = 0;
  for (const r of rows.results) {
    // Always from the amount as charged, so changing currency back and forth doesn't compound rounding.
    const m = await inSiteCurrency(db, r.site_currency, r.original_amount ?? r.amount, r.original_currency ?? r.currency, r.ts);
    if (m.currency !== r.site_currency) continue;
    await db
      .prepare('UPDATE payments SET amount = ?, currency = ?, original_amount = ?, original_currency = ? WHERE site_id = ? AND id = ?')
      .bind(m.amount, m.currency, m.original_amount, m.original_currency, r.site_id, r.id)
      .run();
    converted++;
  }
  return converted;
}
