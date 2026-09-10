-- The rankings data carries each athlete's USA Fencing user id, rating, club
-- and the results behind the points. Keep them. Applied 2026-09-10.
alter table usaf_rankings
  add column if not exists user_id integer,
  add column if not exists rating text,
  add column if not exists club text,
  add column if not exists division text,
  add column if not exists region text,
  add column if not exists carried numeric[],
  add column if not exists results jsonb,
  add column if not exists ties integer;
create index if not exists usaf_rankings_user on usaf_rankings (user_id);
