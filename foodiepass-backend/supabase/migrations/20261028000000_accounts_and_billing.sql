-- FoodiePass accounts and billing schema (spec sections 3, 6, 7).
-- Owner-read RLS on every table; all billing writes happen only through server code (service role).

create extension if not exists pgcrypto;

-- ---------- Offerings: trusted product records (prices never come from the client) ----------
create table public.offerings (
  id               text primary key,                       -- e.g. 'membership_annual', 'gift_membership'
  name             text not null,
  kind             text not null check (kind in ('membership', 'one_time')),
  amount_cents     integer not null check (amount_cents > 0),
  currency         text not null default 'usd',
  billing_interval text check (billing_interval in ('year', 'month')),  -- memberships only
  stripe_price_id  text,                                    -- configured per environment
  fulfillment      text not null check (fulfillment in ('membership_access', 'gift_code')),
  active           boolean not null default false,          -- off until the Stripe price is configured and tested
  sort_order       integer not null default 0,
  updated_at       timestamptz not null default now(),
  check ((kind = 'membership') = (billing_interval is not null))
);

insert into public.offerings (id, name, kind, amount_cents, currency, billing_interval, fulfillment, sort_order) values
  ('membership_annual', 'FoodiePass membership', 'membership', 3000, 'usd', 'year', 'membership_access', 1),
  ('gift_membership',  'FoodiePass gift membership (12 months)', 'one_time', 3000, 'usd', null, 'gift_code', 2);

-- ---------- Stripe customer mapping: exactly one per user, one user per customer ----------
create table public.billing_customers (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

-- ---------- One-time purchases ----------
create table public.purchases (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users (id) on delete cascade,
  offering_id              text not null references public.offerings (id),
  amount_cents             integer not null,
  currency                 text not null,
  stripe_payment_intent_id text unique,
  stripe_checkout_session_id text unique,
  payment_status           text not null default 'pending' check (payment_status in ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'canceled')),
  fulfillment_status       text not null default 'unfulfilled' check (fulfillment_status in ('unfulfilled', 'fulfilled', 'revoked')),
  refunded_amount_cents    integer not null default 0 check (refunded_amount_cents >= 0),
  metadata                 jsonb not null default '{}'::jsonb,       -- non-private details only (e.g. gift recipient first name)
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index purchases_user_idx on public.purchases (user_id);

-- Unique fulfillment record per purchase (spec 6).
create table public.fulfillments (
  purchase_id  uuid primary key references public.purchases (id) on delete cascade,
  kind         text not null,
  created_at   timestamptz not null default now()
);

-- Gift codes created when a gift purchase is paid; redeemed by the recipient's account.
create table public.gift_codes (
  code            text primary key,
  purchase_id     uuid not null unique references public.purchases (id) on delete cascade,
  purchaser_id    uuid not null references auth.users (id) on delete cascade,
  months          integer not null default 12,
  redeemed_by     uuid references auth.users (id) on delete set null,
  redeemed_at     timestamptz,
  revoked         boolean not null default false,
  created_at      timestamptz not null default now()
);

-- ---------- Memberships (Stripe subscriptions) ----------
create table public.subscriptions (
  stripe_subscription_id text primary key,
  user_id                uuid not null references auth.users (id) on delete cascade,
  offering_id            text not null references public.offerings (id),
  stripe_price_id        text not null,
  provider_status        text not null,                      -- Stripe's status, verbatim
  paid_through           timestamptz,                         -- end of the latest PAID period
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  canceled_at            timestamptz,
  ended_at               timestamptz,
  latest_invoice_status  text,
  updated_at             timestamptz not null default now()
);
create index subscriptions_user_idx on public.subscriptions (user_id);

-- ---------- Checkout attempts: one open attempt per user and offering (concurrency lock) ----------
create table public.checkout_attempts (
  id                 uuid primary key,                       -- client-generated per attempt, bound to the user server-side
  user_id            uuid not null references auth.users (id) on delete cascade,
  offering_id        text not null references public.offerings (id),
  purchase_id        uuid references public.purchases (id) on delete set null,
  stripe_session_id  text unique,
  session_url        text,
  status             text not null default 'open' check (status in ('open', 'completed', 'expired', 'canceled', 'failed')),
  idempotency_key    text not null unique,
  expires_at         timestamptz not null default now() + interval '23 hours',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index checkout_attempts_one_open on public.checkout_attempts (user_id, offering_id) where status = 'open';

-- ---------- Webhook events: stored once per Stripe event id, processed durably ----------
create table public.billing_events (
  id              text primary key,                          -- Stripe event id
  type            text not null,
  status          text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'failed', 'ignored')),
  attempts        integer not null default 0,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  last_error      text,                                       -- sanitized, no secrets or card data
  object_id       text                                        -- id of the main Stripe object, for repair
);
create index billing_events_pending_idx on public.billing_events (status, received_at) where status in ('pending', 'failed', 'processing');

-- ---------- Entitlements: what the app actually checks ----------
create table public.entitlements (
  user_id              uuid not null references auth.users (id) on delete cascade,
  feature              text not null,                         -- 'membership'
  source               text not null,                         -- 'subscription:<id>' or 'gift:<code>'
  access_expires_at    timestamptz not null,
  grace_expires_at     timestamptz,
  updated_at           timestamptz not null default now(),
  primary key (user_id, feature, source)
);

-- ---------- Consent and audit ----------
create table public.consents (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  kind          text not null check (kind in ('terms', 'marketing')),
  version       text,
  granted       boolean not null,
  recorded_at   timestamptz not null default now()
);
create index consents_user_idx on public.consents (user_id);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  user_id     uuid,                                           -- kept as plain uuid so the record survives deletion
  action      text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
-- Retention: delete audit rows older than 400 days (run from the reconcile job).

-- ---------- Record terms and marketing consent when an account is created ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare md jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  if md ? 'terms_version' then
    insert into public.consents (user_id, kind, version, granted) values (new.id, 'terms', md->>'terms_version', true);
  end if;
  insert into public.consents (user_id, kind, version, granted)
    values (new.id, 'marketing', md->>'terms_version', coalesce((md->>'marketing_opt_in')::boolean, false));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Membership check used by APIs ----------
create or replace function public.has_membership(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.entitlements
    where user_id = p_user and feature = 'membership'
      and greatest(access_expires_at, coalesce(grace_expires_at, access_expires_at)) > now()
  );
$$;
revoke all on function public.has_membership(uuid) from public, anon;
grant execute on function public.has_membership(uuid) to authenticated, service_role;

-- ---------- Row level security: owners can read their own rows; nobody writes from the browser ----------
alter table public.offerings          enable row level security;
alter table public.billing_customers  enable row level security;
alter table public.purchases          enable row level security;
alter table public.fulfillments       enable row level security;
alter table public.gift_codes         enable row level security;
alter table public.subscriptions      enable row level security;
alter table public.checkout_attempts  enable row level security;
alter table public.billing_events     enable row level security;
alter table public.entitlements       enable row level security;
alter table public.consents           enable row level security;
alter table public.audit_log          enable row level security;

create policy "offerings are public" on public.offerings for select using (active);
create policy "own customer"      on public.billing_customers for select using (auth.uid() = user_id);
create policy "own purchases"     on public.purchases         for select using (auth.uid() = user_id);
create policy "own gift codes"    on public.gift_codes        for select using (auth.uid() = purchaser_id or auth.uid() = redeemed_by);
create policy "own subscriptions" on public.subscriptions     for select using (auth.uid() = user_id);
create policy "own attempts"      on public.checkout_attempts for select using (auth.uid() = user_id);
create policy "own entitlements"  on public.entitlements      for select using (auth.uid() = user_id);
create policy "own consents"      on public.consents          for select using (auth.uid() = user_id);
-- billing_events, fulfillments and audit_log: no policies, so only the service role can touch them.
