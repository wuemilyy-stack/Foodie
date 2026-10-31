// POST /api/billing/webhook — Stripe only. Deploy with --no-verify-jwt.
// Verify the signature on the raw body, store the event once, answer 200 fast, then process.
// Failures stay 'failed' and are retried by billing-reconcile; Stripe's own retries are also safe (idempotent).
import { admin, stripe, cryptoProvider } from '../_shared/clients.ts';
import { runEvent } from '../_shared/billing.ts';
import { logError } from '../_shared/http.ts';

const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const signature = req.headers.get('stripe-signature');
  if (!signature || !secret) return new Response('missing signature', { status: 400 });

  const raw = await req.text(); // raw body: required for signature verification
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, secret, undefined, cryptoProvider);
  } catch {
    return new Response('bad signature', { status: 400 });
  }

  const objectId = (event.data?.object as { id?: string })?.id ?? null;
  const { error } = await admin.from('billing_events').insert({ id: event.id, type: event.type, object_id: objectId });
  if (error && error.code !== '23505') {
    logError('billing-webhook.store', error, { event_id: event.id });
    return new Response('store failed', { status: 500 }); // Stripe will retry
  }
  if (error) return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });

  // Process after responding where the runtime supports it.
  const work = runEvent(event.id);
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work); else await work;

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
