-- The youth national points pages key athletes by USA Fencing member number,
-- not by user id, so a fencer keeps both keys. Every event USA Fencing lists
-- gets a row with its id, and an event's official final placings are kept
-- when read. Applied 2026-09-10.
alter table profiles add column if not exists usaf_member_id text;
create index if not exists profiles_usaf_member on profiles (usaf_member_id);

alter table usaf_rankings
  add column if not exists member_id text,
  add column if not exists moved integer;
create index if not exists usaf_rankings_member on usaf_rankings (member_id);

create table if not exists usaf_events (
  event_id integer primary key,
  tournament_id integer,
  event_code text,
  category text,
  tier text,
  title text,
  tournament text,
  city text,
  event_date date,
  entrants integer,
  read_at timestamptz
);
create index if not exists usaf_events_date on usaf_events (event_date);

create table if not exists usaf_event_results (
  event_id integer not null references usaf_events (event_id) on delete cascade,
  place integer,
  placement text,
  last_name text not null,
  first_name text not null,
  rating text,
  earned_rating text,
  field_type text,
  country text,
  read_at timestamptz not null default now(),
  primary key (event_id, last_name, first_name)
);
create index if not exists usaf_event_results_name on usaf_event_results (lower(last_name), lower(first_name));

alter table usaf_events enable row level security;
alter table usaf_event_results enable row level security;
revoke all on usaf_events from anon;
revoke all on usaf_event_results from anon;
grant select on usaf_events to authenticated;
grant select on usaf_event_results to authenticated;
drop policy if exists usaf_events_read on usaf_events;
create policy usaf_events_read on usaf_events for select to authenticated using (true);
drop policy if exists member_gate on usaf_events;
create policy member_gate on usaf_events as restrictive for all to authenticated using (is_member()) with check (is_member());
drop policy if exists usaf_event_results_read on usaf_event_results;
create policy usaf_event_results_read on usaf_event_results for select to authenticated using (true);
drop policy if exists member_gate on usaf_event_results;
create policy member_gate on usaf_event_results as restrictive for all to authenticated using (is_member()) with check (is_member());
