// POST /api/gift/redeem — authenticated. Body: { code }. Adds 12 months on top of any current access.
import { admin, requireUser, audit } from '../_shared/clients.ts';
import { json, fail, preflight, logError } from '../_shared/http.ts';
import { giftAccessEnd } from '../_shared/entitlements.ts';

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return fail(req, 'bad_request');
  const user = await requireUser(req);
  if (!user) return fail(req, 'unauthenticated');
  if (!user.email_confirmed_at) return fail(req, 'email_unverified');

  let code = '';
  try { code = String((await req.json()).code ?? '').toUpperCase().replace(/\s+/g, ''); } catch { return fail(req, 'bad_request'); }
  if (!/^FP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return fail(req, 'invalid_plan');

  try {
    // Rate limit failed guesses: 10 per hour per user.
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from('audit_log').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('action', 'gift_redeem_failed').gte('created_at', hourAgo);
    if ((count ?? 0) >= 10) return fail(req, 'rate_limited');

    // Atomic claim: only an unredeemed, unrevoked code flips.
    const { data: gift } = await admin.from('gift_codes')
      .update({ redeemed_by: user.id, redeemed_at: new Date().toISOString() })
      .eq('code', code).is('redeemed_by', null).eq('revoked', false)
      .select('code, months').maybeSingle();
    if (!gift) {
      await audit(user.id, 'gift_redeem_failed', {});
      return fail(req, 'invalid_plan');
    }

    const { data: ent } = await admin.from('entitlements').select('access_expires_at').eq('user_id', user.id).eq('feature', 'membership');
    const currentEnd = (ent ?? []).reduce<number>((m, r) => Math.max(m, Date.parse(r.access_expires_at)), 0) || null;
    const end = giftAccessEnd(currentEnd, Date.now(), gift.months);
    await admin.from('entitlements').upsert({
      user_id: user.id, feature: 'membership', source: `gift:${gift.code}`,
      access_expires_at: new Date(end).toISOString(), grace_expires_at: null, updated_at: new Date().toISOString(),
    });
    await audit(user.id, 'gift_redeemed', { months: gift.months });
    return json(req, { ok: true, access_until: new Date(end).toISOString() });
  } catch (e) {
    logError('gift-redeem', e);
    return fail(req, 'server_error');
  }
});
