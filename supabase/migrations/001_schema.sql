-- Delivery Tracker schema
-- Roles: admin (manages users & settings), editor (creates/edits deliveries), viewer (read only)

create extension if not exists pg_cron;

-- ---------- Profiles ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'viewer' check (role in ('admin','editor','viewer')),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

-- Helper functions (security definer so they can be used inside RLS without recursion)
create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid() and is_active), false)
$$;

create or replace function public.can_edit()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','editor') from public.profiles where id = auth.uid() and is_active), false)
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_active from public.profiles where id = auth.uid()), false)
$$;

-- New auth user -> profile. The very first user becomes an active admin;
-- everyone else waits (inactive) until an admin approves them.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare first_user boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles (id, email, full_name, role, is_active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    case when first_user then 'admin' else coalesce(nullif(new.raw_app_meta_data->>'role',''), 'viewer') end,
    case when first_user then true else coalesce((new.raw_app_meta_data->>'active')::boolean, false) end
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stop users from changing their own role / active flag (only admins can)
create or replace function public.protect_profile_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and auth.uid() is not null then
    new.role := old.role;
    new.is_active := old.is_active;
    new.email := old.email;
  end if;
  return new;
end $$;

create trigger protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- ---------- Settings (single row) ----------
create table public.settings (
  id int primary key default 1 check (id = 1),
  due_soon_days int not null default 7,          -- warn when commitment date is within N days
  min_buffer_days int not null default 3,        -- warn when planned arrival leaves fewer than N days before commitment
  default_transit_days int not null default 7,   -- used when no ETA is entered
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

-- ---------- Deliveries ----------
create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  ref_no text not null,                 -- PO / SO / job number
  client text not null,
  project text,
  description text,
  quantity numeric,
  ship_mode text check (ship_mode in ('sea','air','road','courier','other')),
  -- Client commitment
  commitment_date date not null,        -- date promised to client
  -- Production
  production_start date,
  production_due date,                  -- planned production completion
  production_done date,                 -- actual production completion
  -- Shipment
  ship_planned date,                    -- planned ship / ETD
  ship_actual date,                     -- actual ship date
  eta date,                             -- planned arrival at client
  delivered_date date,                  -- actual delivery to client
  status text not null default 'planned'
    check (status in ('planned','in_production','ready_to_ship','shipped','delivered','on_hold','cancelled')),
  owner_id uuid references public.profiles(id) on delete set null,
  notes text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deliveries_commitment_idx on public.deliveries (commitment_date);
create index deliveries_status_idx on public.deliveries (status);
create index deliveries_owner_idx on public.deliveries (owner_id);
create index deliveries_created_by_idx on public.deliveries (created_by);

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;

create trigger deliveries_touch before update on public.deliveries
  for each row execute function public.touch_updated_at();

-- Derived view: lead times and variance vs commitment
create or replace view public.delivery_metrics with (security_invoker = true) as
select
  d.*,
  (d.production_due - d.production_start)                      as production_days_planned,
  (coalesce(d.production_done, d.production_due) - d.production_start) as production_days_actual,
  (d.production_done - d.production_due)                       as production_variance_days,   -- + = late
  (d.ship_actual - d.ship_planned)                             as shipment_variance_days,     -- + = late
  (coalesce(d.eta, d.ship_actual + s.default_transit_days, d.ship_planned + s.default_transit_days) - coalesce(d.ship_actual, d.ship_planned)) as transit_days,
  coalesce(d.delivered_date, d.eta, d.ship_actual + s.default_transit_days, d.ship_planned + s.default_transit_days) as forecast_delivery,
  (d.commitment_date - coalesce(d.delivered_date, d.eta, d.ship_actual + s.default_transit_days, d.ship_planned + s.default_transit_days)) as buffer_days, -- + = early, - = late
  case
    when d.status = 'cancelled' then 'cancelled'
    when d.delivered_date is not null and d.delivered_date <= d.commitment_date then 'on_time'
    when d.delivered_date is not null then 'late'
    when d.commitment_date < (now() at time zone 'Asia/Singapore')::date then 'overdue'
    when coalesce(d.eta, d.ship_actual + s.default_transit_days, d.ship_planned + s.default_transit_days) > d.commitment_date then 'at_risk'
    when (d.commitment_date - coalesce(d.eta, d.ship_actual + s.default_transit_days, d.ship_planned + s.default_transit_days)) < s.min_buffer_days then 'tight'
    else 'on_track'
  end as health
from public.deliveries d cross join public.settings s;

-- Audit trail of date changes
create table public.delivery_history (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references public.deliveries(id) on delete cascade,
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now(),
  field text not null,
  old_value text,
  new_value text
);
create index delivery_history_delivery_idx on public.delivery_history (delivery_id);
create index delivery_history_changed_by_idx on public.delivery_history (changed_by);

create or replace function public.log_delivery_changes()
returns trigger language plpgsql security definer set search_path = public as $$
declare f text;
begin
  foreach f in array array['commitment_date','production_start','production_due','production_done',
                           'ship_planned','ship_actual','eta','delivered_date','status'] loop
    if (to_jsonb(old)->>f) is distinct from (to_jsonb(new)->>f) then
      insert into public.delivery_history (delivery_id, changed_by, field, old_value, new_value)
      values (new.id, auth.uid(), f, to_jsonb(old)->>f, to_jsonb(new)->>f);
    end if;
  end loop;
  return new;
end $$;

create trigger deliveries_history after update on public.deliveries
  for each row execute function public.log_delivery_changes();

-- ---------- Alerts ----------
create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries(id) on delete cascade,
  type text not null check (type in ('commitment_overdue','late_forecast','tight_buffer','due_soon',
                                     'production_overdue','production_after_ship','shipment_overdue')),
  severity text not null check (severity in ('critical','warning','info')),
  message text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index alerts_open_unique on public.alerts (delivery_id, type) where resolved_at is null;
create index alerts_delivery_idx on public.alerts (delivery_id);

create table public.alert_dismissals (
  alert_id uuid references public.alerts(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  primary key (alert_id, user_id)
);
create index alert_dismissals_user_idx on public.alert_dismissals (user_id);

-- Recompute alerts for all open deliveries
create or replace function public.generate_alerts()
returns void language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Singapore')::date;
  s public.settings;
begin
  select * into s from public.settings where id = 1;

  create temp table if not exists _wanted (delivery_id uuid, type text, severity text, message text) on commit drop;
  truncate _wanted;

  insert into _wanted
  select m.id, x.type, x.severity, x.message
  from public.delivery_metrics m
  cross join lateral (values
    ('commitment_overdue', 'critical',
       format('%s (%s): commitment date %s has passed and delivery is not confirmed (%s days overdue)',
              m.ref_no, m.client, to_char(m.commitment_date,'DD Mon YYYY'), today - m.commitment_date),
       m.delivered_date is null and m.commitment_date < today),
    ('late_forecast', 'critical',
       format('%s (%s): forecast delivery %s is %s days after the client commitment %s',
              m.ref_no, m.client, to_char(m.forecast_delivery,'DD Mon YYYY'), -m.buffer_days, to_char(m.commitment_date,'DD Mon YYYY')),
       m.delivered_date is null and m.commitment_date >= today and m.buffer_days < 0),
    ('tight_buffer', 'warning',
       format('%s (%s): only %s day(s) buffer between forecast delivery and commitment (minimum %s)',
              m.ref_no, m.client, m.buffer_days, s.min_buffer_days),
       m.delivered_date is null and m.commitment_date >= today and m.buffer_days >= 0 and m.buffer_days < s.min_buffer_days),
    ('due_soon', 'info',
       format('%s (%s): commitment date %s is in %s day(s)',
              m.ref_no, m.client, to_char(m.commitment_date,'DD Mon YYYY'), m.commitment_date - today),
       m.delivered_date is null and m.commitment_date between today and today + s.due_soon_days),
    ('production_overdue', 'warning',
       format('%s (%s): production was due %s but is not marked complete',
              m.ref_no, m.client, to_char(m.production_due,'DD Mon YYYY')),
       m.production_done is null and m.production_due < today and m.ship_actual is null and m.delivered_date is null),
    ('production_after_ship', 'warning',
       format('%s (%s): production completion %s is after planned shipment %s',
              m.ref_no, m.client, to_char(coalesce(m.production_done, m.production_due),'DD Mon YYYY'), to_char(m.ship_planned,'DD Mon YYYY')),
       m.ship_actual is null and m.delivered_date is null and coalesce(m.production_done, m.production_due) > m.ship_planned),
    ('shipment_overdue', 'warning',
       format('%s (%s): planned shipment %s has passed and shipment is not confirmed',
              m.ref_no, m.client, to_char(m.ship_planned,'DD Mon YYYY')),
       m.ship_actual is null and m.delivered_date is null and m.ship_planned < today)
  ) as x(type, severity, message, active)
  where x.active and m.status not in ('cancelled','on_hold');

  -- resolve alerts that no longer apply
  update public.alerts a set resolved_at = now()
  where a.resolved_at is null
    and not exists (select 1 from _wanted w where w.delivery_id = a.delivery_id and w.type = a.type);

  -- refresh message of still-open alerts
  update public.alerts a set message = w.message, severity = w.severity, updated_at = now()
  from _wanted w
  where a.resolved_at is null and w.delivery_id = a.delivery_id and w.type = a.type and a.message <> w.message;

  -- open new alerts
  insert into public.alerts (delivery_id, type, severity, message)
  select w.delivery_id, w.type, w.severity, w.message from _wanted w
  where not exists (select 1 from public.alerts a where a.resolved_at is null and a.delivery_id = w.delivery_id and a.type = w.type);
end $$;

create or replace function public.trg_generate_alerts()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.generate_alerts(); return null; end $$;

create trigger deliveries_alerts after insert or update or delete on public.deliveries
  for each statement execute function public.trg_generate_alerts();
create trigger settings_alerts after update on public.settings
  for each statement execute function public.trg_generate_alerts();

-- Re-check every day just after midnight Singapore time (16:05 UTC) so date-based alerts appear
select cron.schedule('delivery-alerts-daily', '5 16 * * *', $cron$select public.generate_alerts()$cron$);

-- ---------- Row level security ----------
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.deliveries enable row level security;
alter table public.delivery_history enable row level security;
alter table public.alerts enable row level security;
alter table public.alert_dismissals enable row level security;

create policy "profiles: own row or active users read" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_active_user()));
create policy "profiles: update self or admin" on public.profiles for update to authenticated
  using (id = (select auth.uid()) or (select public.is_admin())) with check (id = (select auth.uid()) or (select public.is_admin()));

create policy "settings: active read" on public.settings for select to authenticated using ((select public.is_active_user()));
create policy "settings: admin update" on public.settings for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "deliveries: active read" on public.deliveries for select to authenticated using ((select public.is_active_user()));
create policy "deliveries: editors insert" on public.deliveries for insert to authenticated with check ((select public.can_edit()));
create policy "deliveries: editors update" on public.deliveries for update to authenticated using ((select public.can_edit())) with check ((select public.can_edit()));
create policy "deliveries: admin delete" on public.deliveries for delete to authenticated using ((select public.is_admin()));

create policy "history: active read" on public.delivery_history for select to authenticated using ((select public.is_active_user()));

create policy "alerts: active read" on public.alerts for select to authenticated using ((select public.is_active_user()));

create policy "dismissals: own" on public.alert_dismissals for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_active_user())) with check (user_id = (select auth.uid()) and (select public.is_active_user()));

-- Lock down helper functions
revoke execute on function public.generate_alerts() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.trg_generate_alerts() from public, anon, authenticated;
revoke execute on function public.log_delivery_changes() from public, anon, authenticated;
revoke execute on function public.protect_profile_fields() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.can_edit() from public, anon;
revoke execute on function public.is_active_user() from public, anon;
revoke execute on function public.current_role_name() from public, anon;
grant execute on function public.is_admin(), public.can_edit(), public.is_active_user(), public.current_role_name() to authenticated;

revoke all on public.delivery_metrics from anon;
grant select on public.delivery_metrics to authenticated;
