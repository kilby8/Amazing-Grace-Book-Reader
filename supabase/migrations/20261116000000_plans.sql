-- Free, Pro and Admin plans (web/PLANS.md).
alter table reader.users
  add column if not exists plan text not null default 'free'
    check (plan in ('free','pro','admin')),
  add column if not exists plan_status text,
  add column if not exists plan_renews_at bigint,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;
create index if not exists users_stripe_sub_idx on reader.users(stripe_subscription_id);
create index if not exists users_stripe_cust_idx on reader.users(stripe_customer_id);

-- Premium (ElevenLabs) voice characters used per month.
create table if not exists reader.tts_usage (
  user_id bigint not null references reader.users(id) on delete cascade,
  month   text not null,
  chars   bigint not null default 0,
  primary key (user_id, month)
);

-- Stripe webhook events already applied (Stripe retries deliveries).
create table if not exists reader.stripe_events (
  id          text primary key,
  received_at bigint not null
);

grant select, insert, update, delete on reader.tts_usage to reader_app;
grant select, insert, delete on reader.stripe_events to reader_app;

-- Admin accounts are set by hand, for existing accounts only:
--   update reader.users set plan = 'admin' where username in ('carpenterjames88', '...');
