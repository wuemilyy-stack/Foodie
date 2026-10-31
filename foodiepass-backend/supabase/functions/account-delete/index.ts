// POST /api/account/delete — authenticated, requires a sign-in within the last 10 minutes.
// Stops Stripe renewals first, then deletes the auth user (tables cascade). Stripe keeps its own payment
// records for tax/accounting; we keep only the anonymous audit rows.
import { admin, stripe, requireUser, secondsSinceAuthentication, audit } from '../_shared/clients.ts';
import { json, fail, preflight, logError } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return fail(req, 'bad_request');
  const user = await requireUser(req);
  if (!user) return fail(req, 'unauthenticated');
  if (secondsSinceAuthentication(req) > 600) return fail(req, 'reauth_required');

  let confirm = '';
  try { confirm = String((await req.json()).confirm ?? ''); } catch { /* empty */ }
  if (confirm !== 'DELETE') return fail(req, 'bad_request');

  try {
    // 1. Cancel every live subscription immediately so nothing renews after the account is gone.
    const { data: subs } = await admin.from('subscriptions').select('stripe_subscription_id, provider_status').eq('user_id', user.id);
    for (const s of subs ?? []) {
      if (!['canceled', 'incomplete_expired'].includes(s.provider_status)) {
        await stripe.subscriptions.cancel(s.stripe_subscription_id, { invoice_now: false, prorate: false });
      }
    }
    // 2. Expire any open checkout sessions.
    const { data: open } = await admin.from('checkout_attempts').select('stripe_session_id').eq('user_id', user.id).eq('status', 'open');
    for (const a of open ?? []) {
      if (a.stripe_session_id) { try { await stripe.checkout.sessions.expire(a.stripe_session_id); } catch { /* already closed */ } }
    }
    // 3. Remove personal details from the Stripe customer (the customer record itself stays for accounting).
    const { data: cust } = await admin.from('billing_customers').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
    if (cust) await stripe.customers.update(cust.stripe_customer_id, { name: '', description: 'deleted FoodiePass account', metadata: { user_id: '', deleted: 'true' } });

    // 4. Delete the account. Foreign keys cascade through our tables.
    await audit(user.id, 'account_deleted', { subscriptions_canceled: (subs ?? []).length });
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw error;
    return json(req, { ok: true });
  } catch (e) {
    logError('account-delete', e);
    return fail(req, 'server_error');
  }
});
