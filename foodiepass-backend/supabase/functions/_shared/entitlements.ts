// Pure membership-access rules (spec section 6). No Deno or network imports, so it can be unit-tested anywhere.

export const GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubscriptionState {
  status: string;                 // Stripe subscription status, verbatim
  paidThrough: number | null;     // ms: end of the latest PAID period
  endedAt: number | null;         // ms: when Stripe ended the subscription, if it has
  cancelAtPeriodEnd: boolean;
}

export interface Access {
  accessExpiresAt: number | null; // null = no paid access from this subscription
  graceExpiresAt: number | null;
  reason: string;
}

/**
 * Translate verified Stripe state into membership access.
 * - Never paid (incomplete, failed, expired): no access.
 * - Paid period: access through paidThrough (also when cancellation is scheduled).
 * - Renewal failed (past_due / unpaid): access through paidThrough plus a 3-day grace.
 * - Paused: access through paidThrough, no grace.
 * - Ended: access stops at the earlier of paidThrough and the end time.
 */
export function membershipAccess(s: SubscriptionState): Access {
  if (!s.paidThrough) return { accessExpiresAt: null, graceExpiresAt: null, reason: 'no_paid_period' };
  if (s.status === 'incomplete' || s.status === 'incomplete_expired') {
    return { accessExpiresAt: null, graceExpiresAt: null, reason: 'initial_payment_not_completed' };
  }
  if (s.status === 'canceled' || s.endedAt) {
    const end = s.endedAt ? Math.min(s.endedAt, s.paidThrough) : s.paidThrough;
    return { accessExpiresAt: end, graceExpiresAt: null, reason: 'ended' };
  }
  if (s.status === 'past_due' || s.status === 'unpaid') {
    return { accessExpiresAt: s.paidThrough, graceExpiresAt: s.paidThrough + GRACE_DAYS * DAY_MS, reason: 'renewal_failed_grace' };
  }
  if (s.status === 'paused') return { accessExpiresAt: s.paidThrough, graceExpiresAt: null, reason: 'paused' };
  // active / trialing (trials are not enabled by default)
  return { accessExpiresAt: s.paidThrough, graceExpiresAt: null, reason: s.cancelAtPeriodEnd ? 'cancel_scheduled' : 'active' };
}

/** True if any access row (expiry or grace) is still in the future. */
export function hasAccess(rows: { accessExpiresAt: number | null; graceExpiresAt: number | null }[], now: number): boolean {
  return rows.some((r) => r.accessExpiresAt !== null && Math.max(r.accessExpiresAt, r.graceExpiresAt ?? 0) > now);
}

/** Gift redemption adds whole months on top of any access the member already has (no lost days). */
export function giftAccessEnd(existingAccessEnd: number | null, now: number, months: number): number {
  const start = new Date(Math.max(existingAccessEnd ?? 0, now));
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + months);
  return end.getTime();
}

/** Stripe sends seconds; we store ms. */
export const sec = (v: number | null | undefined): number | null => (typeof v === 'number' ? v * 1000 : null);
