import { describe, expect, it } from 'vitest';
import type { Site } from '../src/worker/env';
import { dodoIsRenewal, dodoPaymentInput } from '../src/worker/payments';

describe('Dodo renewals', () => {
  const site = { currency: 'USD' } as Site;

  it("reads Dodo's charge type", () => {
    expect(dodoIsRenewal({ charge_type: 'new' })).toBe(false);
    for (const type of ['renewal', 'plan_change', 'on_demand']) expect(dodoIsRenewal({ charge_type: type })).toBe(true);
    // Older payloads without it: decided later by an earlier payment of the same subscription.
    expect(dodoIsRenewal({})).toBe(false);
  });

  it('records a renewal as one', () => {
    const p = dodoPaymentInput(site, { payment_id: 'pay_1', total_amount: 900, currency: 'USD', charge_type: 'renewal', subscription_id: 'sub_1' }, 0);
    expect(p).toMatchObject({ id: 'pay_1', amount: 900, renewal: true, subscriptionId: 'sub_1' });
    expect(dodoPaymentInput(site, { payment_id: 'pay_2', total_amount: 900, currency: 'USD', charge_type: 'new' }, 0).renewal).toBe(false);
  });
});

describe('currency conversion', async () => {
  const { convertWith } = await import('../src/worker/fx');
  const rates = { gbp: 0.76098455, inr: 93.31832517, jpy: 150.2, usd: 1, eur: 0.91179755 };

  it('converts minor units through the per-USD rates', () => {
    expect(convertWith(rates, 912, 'GBP', 'USD')).toBe(1198); // £9.12 -> $11.98
    expect(convertWith(rates, 103295, 'INR', 'USD')).toBe(1107);
    expect(convertWith(rates, 1000, 'USD', 'EUR')).toBe(912);
  });
  it('handles currencies without minor units', () => {
    expect(convertWith(rates, 1502, 'JPY', 'USD')).toBe(1000); // ¥1,502 -> $10.00
    expect(convertWith(rates, 1000, 'USD', 'JPY')).toBe(1502);
  });
  it('leaves the same currency alone and refuses unknown ones', () => {
    expect(convertWith(rates, 912, 'gbp', 'GBP')).toBe(912);
    expect(convertWith(rates, 912, 'XYZ', 'USD')).toBeNull();
  });
});
