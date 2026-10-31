// Run: node --experimental-strip-types --test tests/   (Node 22.6+)   or   deno test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { membershipAccess, hasAccess, giftAccessEnd, GRACE_DAYS, sec } from '../supabase/functions/_shared/entitlements.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1); // 1 Nov 2026
const YEAR_END = Date.UTC(2027, 10, 1);
const base = { status: 'active', paidThrough: YEAR_END, endedAt: null, cancelAtPeriodEnd: false };

test('active paid membership: access through the paid period, no grace', () => {
  const a = membershipAccess(base);
  assert.equal(a.accessExpiresAt, YEAR_END);
  assert.equal(a.graceExpiresAt, null);
  assert.equal(a.reason, 'active');
  assert.ok(hasAccess([a], NOW));
});

test('first payment never completed: no access', () => {
  for (const status of ['incomplete', 'incomplete_expired']) {
    const a = membershipAccess({ ...base, status, paidThrough: null });
    assert.equal(a.accessExpiresAt, null);
    assert.ok(!hasAccess([a], NOW));
  }
  // even if a stale paidThrough is present, an incomplete subscription grants nothing
  assert.equal(membershipAccess({ ...base, status: 'incomplete' }).accessExpiresAt, null);
});

test('cancel at period end keeps access until the end of the paid period', () => {
  const a = membershipAccess({ ...base, cancelAtPeriodEnd: true });
  assert.equal(a.accessExpiresAt, YEAR_END);
  assert.equal(a.reason, 'cancel_scheduled');
  assert.ok(hasAccess([a], YEAR_END - 1));
  assert.ok(!hasAccess([a], YEAR_END));
});

test('failed renewal: 3-day grace after the paid period, then no access', () => {
  const a = membershipAccess({ ...base, status: 'past_due' });
  assert.equal(GRACE_DAYS, 3);
  assert.equal(a.graceExpiresAt, YEAR_END + 3 * DAY);
  assert.ok(hasAccess([a], YEAR_END + 2 * DAY));
  assert.ok(!hasAccess([a], YEAR_END + 3 * DAY));
  assert.equal(membershipAccess({ ...base, status: 'unpaid' }).graceExpiresAt, YEAR_END + 3 * DAY);
});

test('ended subscription: access stops at the earlier of paid period and end time', () => {
  const early = NOW + 10 * DAY; // ended immediately (e.g. account deletion or refund)
  assert.equal(membershipAccess({ ...base, status: 'canceled', endedAt: early }).accessExpiresAt, early);
  assert.equal(membershipAccess({ ...base, status: 'canceled', endedAt: YEAR_END + 5 * DAY }).accessExpiresAt, YEAR_END);
  assert.equal(membershipAccess({ ...base, status: 'canceled', endedAt: early }).graceExpiresAt, null);
});

test('paused: no grace', () => {
  const a = membershipAccess({ ...base, status: 'paused' });
  assert.equal(a.graceExpiresAt, null);
});

test('hasAccess: any live source counts; empty means no', () => {
  assert.ok(!hasAccess([], NOW));
  assert.ok(hasAccess([{ accessExpiresAt: NOW - DAY, graceExpiresAt: null }, { accessExpiresAt: NOW + DAY, graceExpiresAt: null }], NOW));
  assert.ok(!hasAccess([{ accessExpiresAt: null, graceExpiresAt: NOW + DAY }], NOW));
});

test('gift adds 12 months on top of existing access, or from today', () => {
  assert.equal(giftAccessEnd(null, NOW, 12), Date.UTC(2027, 10, 1));
  assert.equal(giftAccessEnd(NOW - DAY, NOW, 12), Date.UTC(2027, 10, 1)); // expired access: start today
  assert.equal(giftAccessEnd(YEAR_END, NOW, 12), Date.UTC(2028, 10, 1)); // stacks, no lost days
});

test('sec converts Stripe seconds to ms', () => {
  assert.equal(sec(1_800_000_000), 1_800_000_000_000);
  assert.equal(sec(null), null);
  assert.equal(sec(undefined), null);
});
