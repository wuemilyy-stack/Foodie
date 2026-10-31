// POST /api/billing/portal — authenticated. Opens Stripe's Customer Portal for the caller's own customer only.
import { admin, stripe, requireUser, SITE_URL } from '../_shared/clients.ts';
import { json, fail, preflight, logError } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return fail(req, 'bad_request');
  const user = await requireUser(req);
  if (!user) return fail(req, 'unauthenticated');
  try {
    const { data } = await admin.from('billing_customers').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
    if (!data) return fail(req, 'not_found');
    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${SITE_URL}/?portal=return#/pass`,
    });
    return json(req, { url: session.url });
  } catch (e) {
    logError('billing-portal', e);
    return fail(req, 'provider_unavailable');
  }
});
