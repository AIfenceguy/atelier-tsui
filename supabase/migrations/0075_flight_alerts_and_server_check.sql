-- The flight checker moves off the PC: Edge Function flight-check prices the
-- watches daily (a full airport sweep on Sundays) and writes every alert it
-- decides on to flight_alerts, sent or not, so the Travel screen can show
-- them. Applied 2026-09-10. SERPAPI_KEY lives in the function secrets; until
-- it is set the daily run reports "skipped" and spends nothing.

create table if not exists flight_alerts (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid references flight_watches (id) on delete cascade,
  reason text,
  subject text,
  message text,
  recipients text[],
  sent_via text,
  error text,
  dry_run boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists flight_alerts_watch on flight_alerts (watch_id, created_at desc);

alter table flight_alerts enable row level security;
revoke all on flight_alerts from anon;
grant select on flight_alerts to authenticated;
drop policy if exists flight_alerts_read on flight_alerts;
create policy flight_alerts_read on flight_alerts for select to authenticated
  using (exists (select 1 from flight_watches w where w.id = flight_alerts.watch_id));
drop policy if exists member_gate on flight_alerts;
create policy member_gate on flight_alerts as restrictive for all to authenticated using (is_member()) with check (is_member());

-- 14:05 UTC is 7:05am Pacific in summer, the hour the PC job used to run.
select cron.unschedule(jobid) from cron.job where jobname = 'en-garde-flight-check';
select cron.schedule('en-garde-flight-check', '5 14 * * *', $$
  select net.http_post(
    url := 'https://kyfkiigbiwhczrtnlivc.supabase.co/functions/v1/flight-check',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from app_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000)
$$);
