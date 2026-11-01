-- Visits confirmed by restaurant staff (the swipe on the member pass).
-- Members can record and read only their own visits, and only while their membership is active.
create table public.redemptions (
  id               bigint generated always as identity primary key,
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  restaurant_id    text not null,
  restaurant_name  text,
  offer            text,
  code             text not null,
  opened_at        timestamptz,
  confirmed_at     timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
create index redemptions_user_idx on public.redemptions (user_id, confirmed_at desc);
create index redemptions_restaurant_idx on public.redemptions (restaurant_id, confirmed_at desc);

alter table public.redemptions enable row level security;
create policy "own visits" on public.redemptions for select using (auth.uid() = user_id);
create policy "members record own visits" on public.redemptions for insert
  with check (auth.uid() = user_id and public.has_membership(auth.uid()));

grant select, insert on public.redemptions to authenticated;
