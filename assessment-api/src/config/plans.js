import { env } from "./env.js";

// Placeholder tiers/limits — pricing and final tier names are not decided yet (see
// docs/plans/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md Phase 2). Adding a real paid tier later is a
// one-entry addition here, not a refactor: give it a stripePriceId and limits, then
// point Checkout at its key.
export const PLANS = {
  free: {
    label: "Free",
    stripePriceId: null,
    seatLimit: 15,
    submissionQuotaPerMonth: 500,
    allowsPremiumProblems: false
  },
  pro: {
    label: "Pro",
    stripePriceId: env.STRIPE_PRICE_ID_PRO,
    seatLimit: Infinity,
    submissionQuotaPerMonth: Infinity,
    allowsPremiumProblems: true
  }
};

export function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}
