// GET /api/billing/config — public. Active offerings and display prices from trusted records.
import { admin, CHECKOUT_ENABLED } from '../_shared/clients.ts';
import { json, fail, preflight, logError } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  try {
    const { data, error } = await admin.from('offerings')
      .select('id, name, kind, amount_cents, currency, billing_interval, stripe_price_id')
      .eq('active', true).order('sort_order');
    if (error) throw error;
    return json(req, {
      checkout_enabled: CHECKOUT_ENABLED,
      offerings: (data ?? []).filter((o) => o.stripe_price_id).map(({ stripe_price_id: _p, ...o }) => o),
    });
  } catch (e) {
    logError('billing-config', e);
    return fail(req, 'server_error');
  }
});
