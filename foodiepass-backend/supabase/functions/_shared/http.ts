// CORS, JSON responses and the shared error codes (spec section 7).

const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow = allowed.includes(origin) ? origin : (allowed[0] ?? '');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export type ErrorCode =
  | 'unauthenticated' | 'email_unverified' | 'already_subscribed' | 'invalid_plan' | 'rate_limited'
  | 'provider_unavailable' | 'checkout_disabled' | 'not_found' | 'bad_request' | 'reauth_required' | 'server_error';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401, email_unverified: 403, already_subscribed: 409, invalid_plan: 400, rate_limited: 429,
  provider_unavailable: 503, checkout_disabled: 503, not_found: 404, bad_request: 400, reauth_required: 401, server_error: 500,
};

// Customer-facing messages are fixed strings; provider errors are never passed through.
const MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: 'Please sign in to continue.',
  email_unverified: 'Please confirm your email address first.',
  already_subscribed: 'Your membership is already active.',
  invalid_plan: 'That option is not available.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  provider_unavailable: 'Payments are temporarily unavailable. Please try again shortly.',
  checkout_disabled: 'New purchases are paused right now. Please try again later.',
  not_found: 'Nothing to show yet.',
  bad_request: 'Something was missing from that request.',
  reauth_required: 'For your security, please sign in again to do this.',
  server_error: 'Something went wrong on our side. Please try again.',
};

export function fail(req: Request, code: ErrorCode, requestId = crypto.randomUUID()): Response {
  return json(req, { error: { code, message: MESSAGE[code], request_id: requestId } }, STATUS[code]);
}

export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders(req) }) : null;
}

/** Log without tokens, codes, emails or card data. */
export function logError(where: string, err: unknown, extra: Record<string, unknown> = {}): void {
  const e = err as { type?: string; code?: string; message?: string };
  console.error(JSON.stringify({ where, type: e?.type, code: e?.code, message: String(e?.message ?? err).slice(0, 300), ...extra }));
}
