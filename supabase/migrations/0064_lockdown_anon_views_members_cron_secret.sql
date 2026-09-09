-- Security lockdown before public launch. Applied 2026-09-09.
-- 1. Views must run as the caller, never as the owner (they bypassed RLS).
alter view fencer_rating_calibration set (security_invoker = on);
alter view trip_overview set (security_invoker = on);
alter view opponent_windows set (security_invoker = on);
alter view opponent_flags set (security_invoker = on);

-- 2. The anon role (the public key, before sign-in) needs nothing in public.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

-- 3. Only members (a login that owns or is attached to a profile) may read
--    shared data. A stranger who signs in with Google gets an empty app.
create or replace function is_member() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where owner_user_id = auth.uid() or login_user_id = auth.uid());
$$;
revoke all on function is_member() from public, anon;
grant execute on function is_member() to authenticated;
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename not in ('profiles', 'household', 'app_secrets') loop
    execute format('drop policy if exists member_gate on %I', t);
    execute format('create policy member_gate on %I as restrictive for all to authenticated using (is_member()) with check (is_member())', t);
  end loop;
end $$;
-- Shared reference tables: members read, nobody but the service role writes.
drop policy if exists drill_library_insert on drill_library;
drop policy if exists drill_library_update on drill_library;
drop policy if exists style_traits_insert on style_traits;
drop policy if exists events_insert on events;

-- 4. Helper functions: authenticated only.
revoke all on function is_parent(), my_household_owner(), kid_can(text), my_visibility(), profile_belongs_to_me(uuid) from public, anon;

-- 5. Pin search_path on every function the linter flagged.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('set_updated_at','tg_touch_updated_at','event_planning_start','event_arrival_deadline','is_school_day','school_days_missed','implied_performance','project_finish','tier_above','cadet_trial_points','cadet_tier','perf_rating','trial_points') loop
    execute format('alter function %s set search_path = public', r.sig);
  end loop;
end $$;

-- 6. A secret for the nightly jobs, generated inside the database and never
--    written to git. Cron sends it; the Edge Functions compare it.
create table if not exists app_secrets (name text primary key, value text not null, created_at timestamptz not null default now());
alter table app_secrets enable row level security;
revoke all on app_secrets from public, anon, authenticated;
insert into app_secrets (name, value) values ('cron_secret', encode(gen_random_bytes(24), 'hex')) on conflict (name) do nothing;
select cron.alter_job(jobid, command := $cmd$
  select net.http_post(
    url := 'https://kyfkiigbiwhczrtnlivc.supabase.co/functions/v1/refresh-due',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from app_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000)
$cmd$) from cron.job where jobname = 'en-garde-refresh-due';
select cron.alter_job(jobid, command := $cmd$
  select net.http_post(
    url := 'https://kyfkiigbiwhczrtnlivc.supabase.co/functions/v1/refresh-local',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from app_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000)
$cmd$) from cron.job where jobname = 'en-garde-refresh-local';

-- 7. The geocode cache is for venues; a home should never sit in it.
delete from places where key ~ '\d{5}' or key ~ '^\d+\s';
