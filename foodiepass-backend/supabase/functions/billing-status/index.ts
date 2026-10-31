// GET /api/billing/status[?attempt=<id>] — authenticated. What the member has right now, from our records.
// If an attempt id is given and its webhook hasn't landed yet, sync that session directly (no waiting on webhook order).
import { admin, stripe, requireUser } from '../_shared/clients.ts';
import { json, fail, preflight, logError } from '../_shared/http.ts';
import { handleCheckoutSession } from '../_shared/billing.ts';

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  const user = await requireUser(req);
  if (!user) return fail(req, 'unauthenticated');

  try {
    const attemptId = new URL(req.url).searchParams.get('attempt');
    let attemptStatus: string | null = null;
    if (attemptId) {
      const { data: a } = await admin.from('checkout_attempts').select('status, stripe_session_id').eq('id', attemptId).eq('user_id', user.id).maybeSingle();
      attemptStatus = a?.status ?? null;
      if (a?.status === 'open' && a.stripe_session_id) {
        const s = await stripe.checkout.sessions.retrieve(a.stripe_session_id);
        if (s.status === 'complete') { await handleCheckoutSession(s.id); attemptStatus = 'completed'; }
      }
    }

    const [ent, subs, gifts, purchases] = await Promise.all([
      admin.from('entitlements').select('source, access_expires_at, grace_expires_at').eq('user_id', user.id).eq('feature', 'membership'),
      admin.from('subscriptions').select('provider_status, paid_through, current_period_end, cancel_at_period_end, latest_invoice_status').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(1),
      admin.from('gift_codes').select('code, redeemed_at, revoked, created_at').eq('purchaser_id', user.id).order('created_at', { ascending: false }),
      admin.from('billing_customers').select('user_id').eq('user_id', user.id).maybeSingle(),
    ]);

    const now = Date.now();
    const rows = ent.data ?? [];
    const activeRows = rows.filter((r) => Math.max(Date.parse(r.access_expires_at), r.grace_expires_at ? Date.parse(r.grace_expires_at) : 0) > now);
    const accessUntil = activeRows.reduce<number>((m, r) => Math.max(m, Date.parse(r.access_expires_at)), 0);
    const inGrace = activeRows.length > 0 && accessUntil <= now;
    const sub = subs.data?.[0] ?? null;

    return json(req, {
      membership: {
        active: activeRows.length > 0,
        access_until: accessUntil ? new Date(accessUntil).toISOString() : null,
        in_grace: inGrace,
        grace_until: inGrace ? activeRows.map((r) => r.grace_expires_at).filter(Boolean).sort().pop() : null,
        source: activeRows.some((r) => r.source.startsWith('subscription:')) ? 'subscription' : activeRows.length ? 'gift' : null,
      },
      subscription: sub && {
        status: sub.provider_status,
        renews: !sub.cancel_at_period_end && ['active', 'trialing'].includes(sub.provider_status),
        cancel_at_period_end: sub.cancel_at_period_end,
        current_period_end: sub.current_period_end,
        payment_problem: ['past_due', 'unpaid'].includes(sub.provider_status) || sub.latest_invoice_status === 'open',
      },
      gift_codes: (gifts.data ?? []).map((g) => ({ code: g.code, redeemed: !!g.redeemed_at, revoked: g.revoked, created_at: g.created_at })),
      can_manage_billing: !!purchases.data,
      attempt_status: attemptStatus,
    });
  } catch (e) {
    logError('billing-status', e);
    return fail(req, 'server_error');
  }
});
