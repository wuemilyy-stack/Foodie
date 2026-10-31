// Shared sync logic used by the webhook and the reconciliation job.
// Everything is re-read from Stripe and written idempotently (upserts keyed by Stripe ids).
import { admin, stripe, audit, type Stripe } from './clients.ts';
import { membershipAccess, giftAccessEnd, sec } from './entitlements.ts';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export async function userIdForCustomer(customerId: string): Promise<string | null> {
  const { data } = await admin.from('billing_customers').select('user_id').eq('stripe_customer_id', customerId).maybeSingle();
  return data?.user_id ?? null;
}

async function offeringForPrice(priceId: string): Promise<string | null> {
  const { data } = await admin.from('offerings').select('id').eq('stripe_price_id', priceId).maybeSingle();
  return data?.id ?? null;
}

/** Pull the subscription from Stripe and rewrite our record and the membership entitlement. */
export async function syncSubscription(subscriptionId: string): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const userId = (sub.metadata?.user_id as string | undefined) ?? (await userIdForCustomer(customerId));
  if (!userId) throw new Error('subscription has no known user');

  const priceId = sub.items.data[0]?.price?.id ?? '';
  const offeringId = (sub.metadata?.offering_id as string | undefined) ?? (await offeringForPrice(priceId));
  if (!offeringId) throw new Error('subscription price is not a known offering');

  const invoice = sub.latest_invoice as Stripe.Invoice | null;
  const invoiceStatus = invoice?.status ?? null;

  // Paid-through only moves forward, and only on a paid invoice.
  const { data: existing } = await admin.from('subscriptions').select('paid_through').eq('stripe_subscription_id', sub.id).maybeSingle();
  let paidThrough = existing?.paid_through ? Date.parse(existing.paid_through) : null;
  if (invoiceStatus === 'paid' || (invoice && invoice.amount_due === 0 && invoiceStatus !== 'open')) {
    const end = sec(sub.current_period_end)!;
    paidThrough = Math.max(paidThrough ?? 0, end);
  } else if ((sub.status === 'past_due' || sub.status === 'unpaid') && !paidThrough) {
    // A renewal failed but we never saw the earlier payment: the previous period ended when this one started.
    paidThrough = sec(sub.current_period_start);
  }

  await admin.from('subscriptions').upsert({
    stripe_subscription_id: sub.id,
    user_id: userId,
    offering_id: offeringId,
    stripe_price_id: priceId,
    provider_status: sub.status,
    paid_through: iso(paidThrough),
    current_period_end: iso(sec(sub.current_period_end)),
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: iso(sec(sub.canceled_at)),
    ended_at: iso(sec(sub.ended_at)),
    latest_invoice_status: invoiceStatus,
    updated_at: new Date().toISOString(),
  });

  const access = membershipAccess({
    status: sub.status,
    paidThrough,
    endedAt: sec(sub.ended_at),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  });
  const source = `subscription:${sub.id}`;
  if (access.accessExpiresAt === null) {
    await admin.from('entitlements').delete().match({ user_id: userId, feature: 'membership', source });
  } else {
    await admin.from('entitlements').upsert({
      user_id: userId, feature: 'membership', source,
      access_expires_at: iso(access.accessExpiresAt),
      grace_expires_at: iso(access.graceExpiresAt),
      updated_at: new Date().toISOString(),
    });
  }
}

function newGiftCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `FP-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/** A completed Checkout Session. Memberships hand off to syncSubscription; one-time purchases fulfil exactly once. */
export async function handleCheckoutSession(sessionId: string): Promise<void> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const attemptId = session.metadata?.attempt_id ?? session.client_reference_id ?? null;

  if (session.mode === 'subscription' && session.subscription) {
    const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    await syncSubscription(subId);
  }

  if (session.mode === 'payment') {
    const { data: purchase } = await admin.from('purchases').select('*').eq('stripe_checkout_session_id', session.id).maybeSingle();
    if (purchase) {
      const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
      if (session.payment_status === 'paid') {
        await admin.from('purchases').update({ payment_status: 'paid', stripe_payment_intent_id: pi, updated_at: new Date().toISOString() }).eq('id', purchase.id);
        await fulfilPurchase(purchase.id);
      }
    }
  }

  if (attemptId && session.status === 'complete') {
    await admin.from('checkout_attempts').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', attemptId);
  }
  if (attemptId && session.status === 'expired') {
    await admin.from('checkout_attempts').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', attemptId).eq('status', 'open');
  }
}

/** Fulfilment is guarded by the fulfillments primary key, so a replayed event cannot create a second gift code. */
export async function fulfilPurchase(purchaseId: string): Promise<void> {
  const { data: purchase } = await admin.from('purchases').select('*, offerings(fulfillment)').eq('id', purchaseId).single();
  if (!purchase || purchase.payment_status !== 'paid') return;
  const kind = (purchase.offerings as { fulfillment: string }).fulfillment;

  const { error: claimErr } = await admin.from('fulfillments').insert({ purchase_id: purchaseId, kind });
  if (claimErr) {
    if (claimErr.code === '23505') return; // already fulfilled
    throw claimErr;
  }
  if (kind === 'gift_code') {
    for (let i = 0; i < 5; i++) {
      const { error } = await admin.from('gift_codes').insert({ code: newGiftCode(), purchase_id: purchaseId, purchaser_id: purchase.user_id, months: 12 });
      if (!error) break;
      if (error.code !== '23505' || i === 4) throw error;
    }
  }
  await admin.from('purchases').update({ fulfillment_status: 'fulfilled', updated_at: new Date().toISOString() }).eq('id', purchaseId);
  await audit(purchase.user_id, 'purchase_fulfilled', { purchase_id: purchaseId, kind });
}

/** Refunds and disputes revoke what was granted. */
export async function handleCharge(chargeId: string): Promise<void> {
  const charge = await stripe.charges.retrieve(chargeId);
  const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!pi) return;
  const { data: purchase } = await admin.from('purchases').select('id, user_id, amount_cents').eq('stripe_payment_intent_id', pi).maybeSingle();
  if (!purchase) return; // subscription invoices are handled through the subscription
  const refunded = charge.amount_refunded;
  const disputed = charge.disputed;
  const full = disputed || refunded >= purchase.amount_cents;
  await admin.from('purchases').update({
    refunded_amount_cents: refunded,
    payment_status: full ? 'refunded' : refunded > 0 ? 'partially_refunded' : 'paid',
    fulfillment_status: full ? 'revoked' : 'fulfilled',
    updated_at: new Date().toISOString(),
  }).eq('id', purchase.id);
  if (full) {
    const { data: gift } = await admin.from('gift_codes').update({ revoked: true }).eq('purchase_id', purchase.id).select('code, redeemed_by').maybeSingle();
    if (gift?.redeemed_by) {
      await admin.from('entitlements').delete().match({ user_id: gift.redeemed_by, feature: 'membership', source: `gift:${gift.code}` });
    }
    await audit(purchase.user_id, 'purchase_revoked', { purchase_id: purchase.id, disputed });
  }
}

/** Route a verified event to the right sync. Unknown types are ignored. */
export async function processEvent(event: Stripe.Event): Promise<'processed' | 'ignored'> {
  const obj = event.data.object as { id: string; subscription?: string | { id: string } | null };
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      await handleCheckoutSession(obj.id);
      return 'processed';
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      await syncSubscription(obj.id);
      return 'processed';
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.payment_action_required': {
      const sub = obj.subscription;
      if (!sub) return 'ignored';
      await syncSubscription(typeof sub === 'string' ? sub : sub.id);
      return 'processed';
    }
    case 'charge.refunded':
    case 'charge.dispute.created':
      await handleCharge(event.type === 'charge.dispute.created' ? String((event.data.object as { charge: string }).charge) : obj.id);
      return 'processed';
    default:
      return 'ignored';
  }
}

/** Process one stored event. Claimed atomically so only one worker runs it; failures stay retryable. */
export async function runEvent(eventId: string): Promise<void> {
  const { data: claimed } = await admin.from('billing_events')
    .update({ status: 'processing' })
    .eq('id', eventId).in('status', ['pending', 'failed'])
    .select('attempts').maybeSingle();
  if (!claimed) return;
  try {
    const event = await stripe.events.retrieve(eventId); // re-read from Stripe: never trust stored payloads
    const result = await processEvent(event);
    await admin.from('billing_events').update({ status: result, processed_at: new Date().toISOString(), attempts: claimed.attempts + 1, last_error: null }).eq('id', eventId);
  } catch (e) {
    console.error(JSON.stringify({ where: 'runEvent', event_id: eventId, message: String((e as Error)?.message ?? e).slice(0, 300) }));
    await admin.from('billing_events').update({ status: 'failed', attempts: claimed.attempts + 1, last_error: String((e as Error)?.message ?? e).slice(0, 300) }).eq('id', eventId);
  }
}

export { giftAccessEnd };
