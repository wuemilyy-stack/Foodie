// Supabase admin client, user authentication and Stripe client. Secrets stay server-side.
import { createClient, type SupabaseClient, type User } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import Stripe from 'https://esm.sh/stripe@14.25.0?target=deno';

export const admin: SupabaseClient = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});
export const cryptoProvider = Stripe.createSubtleCryptoProvider();
export type { Stripe };

export const SITE_URL = (Deno.env.get('SITE_URL') ?? '').replace(/\/+$/, '');
export const CHECKOUT_ENABLED = (Deno.env.get('CHECKOUT_ENABLED') ?? 'true') !== 'false';

/** Validates the caller's access token with Supabase Auth on every protected request. */
export async function requireUser(req: Request): Promise<User | null> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

/** Seconds since the user last actually authenticated (from the token's amr claim), for sensitive actions. */
export function secondsSinceAuthentication(req: Request): number {
  try {
    const token = (req.headers.get('authorization') ?? '').slice(7);
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const times = (payload.amr ?? []).map((a: { timestamp?: number }) => a.timestamp ?? 0);
    const last = Math.max(0, ...times);
    return last ? Math.floor(Date.now() / 1000) - last : Infinity;
  } catch {
    return Infinity;
  }
}

export async function audit(userId: string | null, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  await admin.from('audit_log').insert({ user_id: userId, action, detail });
}
