-- The plan's tournaments keyed to USA Fencing's tournament ids by name and
-- weekend, each event's USA Fencing id, and the live entry picture from the
-- tournament page (official competitors, open spots, cap, close of
-- registration). Applied 2026-09-10.
alter table season_events
  add column if not exists usaf_event_id integer,
  add column if not exists official integer,
  add column if not exists open_spots integer,
  add column if not exists cap boolean,
  add column if not exists reg_close text,
  add column if not exists usaf_read_at timestamptz;
create index if not exists season_events_usaf_event on season_events (usaf_event_id);

alter table usaf_events
  add column if not exists official integer,
  add column if not exists open_spots integer,
  add column if not exists cap boolean,
  add column if not exists reg_close text,
  add column if not exists possible text,
  add column if not exists venue text;

create table if not exists usaf_tournaments (
  tournament_id integer primary key,
  name text,
  scope text,
  start_date date,
  end_date date,
  venue text,
  city text,
  read_at timestamptz
);
alter table usaf_tournaments enable row level security;
revoke all on usaf_tournaments from anon;
grant select on usaf_tournaments to authenticated;
drop policy if exists usaf_tournaments_read on usaf_tournaments;
create policy usaf_tournaments_read on usaf_tournaments for select to authenticated using (true);
drop policy if exists member_gate on usaf_tournaments;
create policy member_gate on usaf_tournaments as restrictive for all to authenticated using (is_member()) with check (is_member());
