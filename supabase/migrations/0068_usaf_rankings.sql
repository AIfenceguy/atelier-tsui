-- A snapshot of a USA Fencing national ranking page, so the app can say
-- where a registered field's entrants sit on the real ranking: for a Cadet
-- NAC, who fills the Elite bracket and whether the boy is inside it.
-- Applied 2026-09-09; Cadet MF ranks 1-200 loaded from ranking_id 9081798.
create table if not exists usaf_rankings (
  category text not null,
  weapon text not null default 'MF',
  rank integer not null,
  name text not null,
  points numeric,
  yob integer,
  as_of date not null,
  ranking_id text,
  primary key (category, weapon, as_of, name)
);
create index if not exists usaf_rankings_lookup on usaf_rankings (category, weapon, as_of, rank);
alter table usaf_rankings enable row level security;
revoke all on usaf_rankings from anon;
grant select on usaf_rankings to authenticated;
drop policy if exists usaf_rankings_read on usaf_rankings;
create policy usaf_rankings_read on usaf_rankings for select to authenticated using (true);
drop policy if exists member_gate on usaf_rankings;
create policy member_gate on usaf_rankings as restrictive for all to authenticated using (is_member()) with check (is_member());
