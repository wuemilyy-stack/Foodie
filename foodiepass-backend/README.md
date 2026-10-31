# FoodiePass accounts and payments backend

This is the server half of `login-and-payments-spec.md`. It runs on Supabase (Postgres, Auth and Edge Functions) and Stripe (Checkout, Customer Portal and webhooks). The website (`../foodiepass-website.html`) calls it directly.

## What's here

| Path | What it does |
|---|---|
| `supabase/migrations/20261028000000_accounts_and_billing.sql` | Tables, RLS, consent trigger, `has_membership()` |
| `supabase/functions/billing-config` | `GET`. Public: active offerings and prices |
| `supabase/functions/billing-checkout` | `POST {offeringId, attemptId}`. Opens a Stripe Checkout session (one open attempt per user and offering) |
| `supabase/functions/billing-portal` | `POST`. Opens the Stripe Customer Portal |
| `supabase/functions/billing-status` | `GET ?attempt=`. Membership, subscription, gift codes; also syncs a just-finished checkout |
| `supabase/functions/billing-webhook` | Stripe webhook. Verifies the signature, stores each event once, then processes it |
| `supabase/functions/billing-reconcile` | Cron job every 15 minutes. Retries failed events, re-syncs from Stripe, closes stale attempts, prunes old rows |
| `supabase/functions/gift-redeem` | `POST {code}`. Adds 12 months on top of any existing access |
| `supabase/functions/account-delete` | `POST {confirm:"DELETE"}`. Needs a sign-in in the last 10 minutes. Cancels renewals, then deletes the account |
| `supabase/functions/_shared/entitlements.ts` | Pure access rules: paid period, 3-day grace, cancel at period end |
| `tests/entitlements.test.ts` | `node --experimental-strip-types --test tests/entitlements.test.ts` |

## Setup (about an hour, test mode first)

### 1. Supabase project

1. Create a project in the FoodiePass org. The free plan allows 2 active projects per account, so pause one or upgrade if you hit the limit. Choose the database password yourself.
2. Install the CLI, then run `supabase link --project-ref <ref>` and `supabase db push` from this folder.
3. Go to **Authentication → Providers → Email**. Turn on Email and turn off "Confirm email" link mode. The site uses 6-digit codes.
4. Until custom SMTP is set up (step 6), Supabase only sends its default email, which contains a sign-in link and no code. While that's the case, keep `AUTH_CONFIG.emailMode = 'link'` on the website. After SMTP is configured, go to **Authentication → Email Templates**. In both **Magic Link** and **Confirm signup**, put the code in the body, for example `Your FoodiePass code is {{ .Token }}. It expires in 10 minutes.`. Then set `emailMode: 'code'` on the website.
5. Go to **Authentication → URL Configuration**:
   - **Site URL:** your live site, for example `https://foodiespasses.netlify.app`
   - **Redirect URLs:** add the same URL, plus `http://localhost:*` for testing.
6. Go to **Authentication → SMTP**. Add a real sender (Resend, Postmark or SES) before launch. Supabase's built-in mailer is limited to a few emails an hour.
7. Optional: set up Google, Facebook or Apple under **Authentication → Providers**, then set each flag to `true` in `AUTH_CONFIG.providers` on the website.

### 2. Stripe (test mode)

1. Create the products:
   - **FoodiePass membership:** recurring yearly price of $30.
   - **FoodiePass gift membership:** one-time price of $30.
2. In Supabase's SQL editor, link the prices to the offerings and switch the offerings on:
   ```sql
   update offerings set stripe_price_id = 'price_...', active = true where id = 'membership_annual';
   update offerings set stripe_price_id = 'price_...', active = true where id = 'gift_membership';
   ```
3. Go to **Settings → Billing → Customer portal**. Allow card updates, invoice history and cancellation at the end of the period.
4. Go to **Developers → Webhooks → Add endpoint**:
   - URL: `https://<ref>.supabase.co/functions/v1/billing-webhook`
   - Events:
     - `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
     - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`
     - `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`
     - `charge.refunded`, `charge.dispute.created`
5. Go to **Billing → Revenue recovery**. Turn on Smart Retries and failed-payment emails.

### 3. Secrets and deploy

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  SITE_URL=https://foodiespasses.netlify.app \
  ALLOWED_ORIGINS=https://foodiespasses.netlify.app,http://localhost:8080 \
  CRON_SECRET=$(openssl rand -hex 24) \
  CHECKOUT_ENABLED=true

supabase functions deploy billing-config billing-checkout billing-portal billing-status gift-redeem account-delete
supabase functions deploy billing-webhook billing-reconcile --no-verify-jwt
```

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the functions automatically. Never put the service-role key or any Stripe secret in the website.

### 4. Reconcile cron

Run this in the SQL editor. It needs the `pg_cron` and `pg_net` extensions.

```sql
select cron.schedule('billing-reconcile', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://<ref>.supabase.co/functions/v1/billing-reconcile',
    headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>')
  );
$$);
```

### 5. Website

In `foodiepass-website.html`, fill in `AUTH_CONFIG.supabaseUrl` and `AUTH_CONFIG.supabaseAnonKey` (Project Settings → API). Then run `python3 tools/build_site.py` from the Foodie folder. It escapes characters and rebuilds `netlify-deploy/` and the zip.

## Test plan (Stripe test mode)

| Case | Expected |
|---|---|
| Card `4242 4242 4242 4242` | Returns to My pass, shows "Confirming…", then the membership is active |
| Double-click "Continue to payment" | One Checkout session, one charge |
| Card `4000 0000 0000 0002` (declined) | No access, no subscription |
| Card `4000 0025 0000 3155` (3-D Secure) | Access starts after authentication |
| Stripe CLI: `stripe trigger invoice.payment_failed` | "Renewal didn't go through" banner; access lasts 3 days past the paid date |
| Portal → cancel | "It will not renew"; access lasts until the end of the period |
| Gift purchase | A gift code appears under Account; redeeming it on another account adds 12 months |
| Full refund of a gift | Code shows Cancelled; the recipient's gift access is removed |
| Replay a webhook (`stripe events resend evt_...`) | No change; logged as a duplicate |
| Delete account (within 10 minutes of signing in) | Subscription cancelled in Stripe, then the user is removed |

## Go-live checklist

- Switch to live Stripe keys, prices and a live webhook secret, and re-run the `update offerings` statements with the live price ids.
- Custom SMTP is configured and SPF, DKIM and DMARC pass.
- Terms and privacy pages cover auto-renewal and cancellation (Texas and FTC negative-option rules).
- Set `CHECKOUT_ENABLED=false` to pause new purchases in an emergency without a redeploy.
