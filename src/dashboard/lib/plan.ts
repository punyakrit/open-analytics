import { useEffect, useState } from 'react';
import { api, type PlanInfo } from './api';

/** The paid plan on offer in hosted mode (null until loaded, or when the request fails). */
export function usePlan() {
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  useEffect(() => {
    api<PlanInfo>('/api/public/plan').then(setPlan, () => {});
  }, []);
  return plan;
}

/** "$29 lifetime" or "$9/month". */
export function priceLabel(plan: PlanInfo | null) {
  if (!plan) return '';
  return plan.interval === 'lifetime' ? `${plan.price} lifetime` : `${plan.price}/${plan.interval}`;
}
