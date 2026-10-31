// POST /api/billing/checkout — authenticated. Body: { offeringId, attemptId }.
// The server picks the price; the client only names an offering. One open attempt per user and offering.
import { admin, stripe, requireUser, SITE_URL, CHECKOUT_ENABLED, audit } from '../_shared/clients.ts';
import { json, fail, preflight, logError } from '../_shared/http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function getOrCreateCustomer(userId: string, email: string): Promise<string> {
  const { data } = await admin.from('billing_customers').select('stripe_customer_id').eq('user_id', userId).maybeSingle();
  if (data) return data.stripe_customer_id;
  const customer = await stripe.customers.create(
    { email, metadata: { user_id: userId } },
    { idempotencyKey: `customer-${userId}` },
  );
  const { error } = await admin.from('billing_customers').insert({ user_id: userId, stripe_customer_id: customer.id });
  if (error && error.code !== '23505') throw error;
  if (error) { // lost a race: use the stored one
    const { data: again } = await admin.from('billing_customers').select('stripe_customer_id').eq('user_id', userId).single();
    return again!.stripe_customer_id;
  }
  return customer.id;
}

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return fail(req, 'bad_request');
  if (!CHECKOUT_ENABLED) return fail(req, 'checkout_disabled');

  const user = await requireUser(req);
  if (!user) return fail(req, 'unauthenticated');
  if (!user.email || !user.email_confirmed_at) return fail(req, 'email_unverified');

  let body: { offeringId?: string; attemptId?: string };
  try { body = await req.json(); } catch { return fail(req, 'bad_request'); }
  const { offeringId, attemptId } = body;
  if (!offeringId || !attemptId || !UUID.test(attemptId)) return fail(req, 'bad_request');

  try {
    const { data: offering } = await admin.from('offerings').select('*').eq('id', offeringId).eq('active', true).maybeSingle();
    if (!offering || !offering.stripe_price_id) return fail(req, 'invalid_plan');

    // Already a member? Send them to manage, not to pay twice.
    if (offering.kind === 'membership') {
      const { data: active } = await admin.rpc('has_membership', { p_user: user.id });
      const { data: liveSub } = await admin.from('subscriptions').select('stripe_subscription_id')
        .eq('user_id', user.id).in('provider_status', ['active', 'trialing', 'past_due', 'unpaid', 'paused']).limit(1);
      if (active || (liveSub && liveSub.length)) return fail(req, 'already_subscribed');
    }

    // Light rate limit: at most 10 attempts per user per hour.
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from('checkout_attempts').select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', hourAgo);
    if ((count ?? 0) >= 10) return fail(req, 'rate_limited');

    // Same attempt id retried (double click, network retry): return the same session.
    const { data: same } = await admin.from('checkout_attempts').select('*').eq('id', attemptId).maybeSingle();
    if (same) {
      if (same.user_id !== user.id) return fail(req, 'bad_request');
      if (same.status === 'open' && same.session_url && Date.parse(same.expires_at) > Date.now()) return json(req, { url: same.session_url, attempt_id: same.id });
    }

    // Another open attempt for this offering: reuse it if Stripe still has it open, otherwise expire it.
    const { data: open } = await admin.from('checkout_attempts').select('*').eq('user_id', user.id).eq('offering_id', offeringId).eq('status', 'open').maybeSingle();
    if (open && open.id !== attemptId) {
      let reusable = false;
      if (open.stripe_session_id && Date.parse(open.expires_at) > Date.now()) {
        try {
          const s = await stripe.checkout.sessions.retrieve(open.stripe_session_id);
          reusable = s.status === 'open' && !!s.url;
          if (reusable) return json(req, { url: s.url, attempt_id: open.id });
          if (s.status === 'complete') return fail(req, 'already_subscribed');
        } catch { /* fall through and replace it */ }
      }
      await admin.from('checkout_attempts').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', open.id).eq('status', 'open');
    }

    // Claim the lock. The partial unique index rejects a concurrent second open attempt.
    if (!same) {
      const { error: lockErr } = await admin.from('checkout_attempts').insert({
        id: attemptId, user_id: user.id, offering_id: offeringId, idempotency_key: `checkout-${attemptId}`,
      });
      if (lockErr) return fail(req, lockErr.code === '23505' ? 'rate_limited' : 'server_error');
    }

    const customerId = await getOrCreateCustomer(user.id, user.email);
    const metadata = { user_id: user.id, offering_id: offeringId, attempt_id: attemptId };

    let purchaseId: string | null = null;
    if (offering.kind === 'one_time') {
      const { data: p, error } = await admin.from('purchases').insert({
        user_id: user.id, offering_id: offeringId, amount_cents: offering.amount_cents, currency: offering.currency,
      }).select('id').single();
      if (error) throw error;
      purchaseId = p.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: offering.kind === 'membership' ? 'subscription' : 'payment',
      customer: customerId,
      client_reference_id: attemptId,
      line_items: [{ price: offering.stripe_price_id, quantity: 1 }],
      success_url: `${SITE_URL}/?checkout=success&attempt=${attemptId}#/pass`,
      cancel_url: `${SITE_URL}/?checkout=canceled#/join`,
      metadata: { ...metadata, ...(purchaseId ? { purchase_id: purchaseId } : {}) },
      ...(offering.kind === 'membership'
        ? { subscription_data: { metadata } }
        : { payment_intent_data: { metadata: { ...metadata, purchase_id: purchaseId! } } }),
      allow_promotion_codes: true,
      automatic_tax: { enabled: (Deno.env.get('STRIPE_AUTOMATIC_TAX') ?? 'false') === 'true' },
    }, { idempotencyKey: `checkout-${attemptId}` });

    await admin.from('checkout_attempts').update({
      stripe_session_id: session.id, session_url: session.url, purchase_id: purchaseId,
      expires_at: new Date(session.expires_at * 1000).toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', attemptId);
    if (purchaseId) await admin.from('purchases').update({ stripe_checkout_session_id: session.id }).eq('id', purchaseId);
    await audit(user.id, 'checkout_started', { offering_id: offeringId, attempt_id: attemptId });

    return json(req, { url: session.url, attempt_id: attemptId });
  } catch (e) {
    logError('billing-checkout', e, { attempt_id: attemptId });
    await admin.from('checkout_attempts').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', attemptId).eq('status', 'open').is('stripe_session_id', null);
    const type = (e as { type?: string })?.type ?? '';
    return fail(req, type.startsWith('Stripe') ? 'provider_unavailable' : 'server_error');
  }
});
