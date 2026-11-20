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
