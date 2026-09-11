-- The app's own rating, first version: an Elo over placings. Every placing
-- USA Fencing publishes (the ranked athletes' results on the points and
-- ranking pages, and the full official results of any event read) becomes a
-- set of pairwise outcomes: whoever placed higher beat whoever placed lower.
-- Events are replayed in date order; each athlete's rating moves by K times
-- (actual share of the field beaten - expected share). The scale is then
-- fitted to the FencingTracker strength numbers the app already shows, so
-- the two read alike. Applied 2026-09-10 (three steps: tables and replay,
-- float math, calibration floor + nightly cron). First run: 169 events,
-- 508 athletes, calibrated on 262 with r2 0.62.

create table if not exists athlete_results (
  athlete_key text not null,
  name text,
  yob integer,
  member_id text,
  event_id integer not null,
  event_date date not null,
  category text,
  tier text,
  place integer not null,
  field integer,
  source text not null,
  primary key (athlete_key, event_id)
);
create index if not exists athlete_results_event on athlete_results (event_id);
create index if not exists athlete_results_date on athlete_results (event_date);

create table if not exists athlete_ratings (
  athlete_key text primary key,
  name text,
  yob integer,
  member_id text,
  rating numeric not null,
  games integer not null default 0,
  last_event date,
  strength_est integer,
  ft_strength integer,
  updated_at timestamptz not null default now()
);
create index if not exists athlete_ratings_member on athlete_ratings (member_id);

create table if not exists rating_calibration (
  id integer primary key default 1,
  slope numeric,
  intercept numeric,
  n integer,
  r2 numeric,
  k numeric,
  events integer,
  athletes integer,
  updated_at timestamptz not null default now()
);

alter table athlete_results enable row level security;
alter table athlete_ratings enable row level security;
alter table rating_calibration enable row level security;
revoke all on athlete_results from anon;
revoke all on athlete_ratings from anon;
revoke all on rating_calibration from anon;
grant select on athlete_results to authenticated;
grant select on athlete_ratings to authenticated;
grant select on rating_calibration to authenticated;
drop policy if exists athlete_results_read on athlete_results;
create policy athlete_results_read on athlete_results for select to authenticated using (true);
drop policy if exists member_gate on athlete_results;
create policy member_gate on athlete_results as restrictive for all to authenticated using (is_member()) with check (is_member());
drop policy if exists athlete_ratings_read on athlete_ratings;
create policy athlete_ratings_read on athlete_ratings for select to authenticated using (true);
drop policy if exists member_gate on athlete_ratings;
create policy member_gate on athlete_ratings as restrictive for all to authenticated using (is_member()) with check (is_member());
drop policy if exists rating_calibration_read on rating_calibration;
create policy rating_calibration_read on rating_calibration for select to authenticated using (true);
drop policy if exists member_gate on rating_calibration;
create policy member_gate on rating_calibration as restrictive for all to authenticated using (is_member()) with check (is_member());

-- "Tsui, Raedyn Ho Hin" / "TSUI Raedyn" / last + first -> "tsui|raedyn".
-- Case-insensitive throughout; the first given name only, parentheses dropped.
create or replace function athlete_key(p_last text, p_first text)
returns text language sql immutable as $$
  select lower(regexp_replace(trim(p_last), '\s+', ' ', 'g')) || '|' ||
         lower(split_part(trim(regexp_replace(coalesce(p_first, ''), '\(.*?\)', '', 'g')), ' ', 1));
$$;

create or replace function athlete_key_from_name(p_name text)
returns text language sql immutable as $$
  select case
    when position(',' in coalesce(p_name, '')) > 0
      then athlete_key(split_part(p_name, ',', 1), split_part(p_name, ',', 2))
    else athlete_key(split_part(trim(p_name), ' ', 1), regexp_replace(trim(p_name), '^\S+\s*', ''))
  end;
$$;

-- Flatten every placing the app holds into athlete_results.
create or replace function rebuild_athlete_results()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from athlete_results;
  -- The ranked athletes' results, from the latest snapshot of each list.
  insert into athlete_results (athlete_key, name, yob, member_id, event_id, event_date, category, tier, place, field, source)
  select distinct on (athlete_key_from_name(r.name), (x->>'event_id')::integer)
         athlete_key_from_name(r.name), r.name, r.yob, r.member_id,
         (x->>'event_id')::integer, (x->>'event_date')::date,
         coalesce(e.category, lower(left(x->>'event_code', 3))), coalesce(e.tier, x->>'tier'),
         (x->>'place')::integer, e.entrants, 'rankings'
  from usaf_rankings r
  join (select category, max(as_of) as as_of from usaf_rankings group by category) l
    on l.category = r.category and l.as_of = r.as_of
  cross join lateral jsonb_array_elements(coalesce(r.results, '[]'::jsonb)) x
  left join usaf_events e on e.event_id = (x->>'event_id')::integer
  where coalesce(x->>'event_id', '') <> '' and coalesce(x->>'event_date', '') <> ''
    and coalesce(x->>'place', '') ~ '^\d+$' and (x->>'place')::integer > 0
  order by athlete_key_from_name(r.name), (x->>'event_id')::integer, r.category;
  -- The full official field of every event read: these rows win.
  insert into athlete_results (athlete_key, name, yob, member_id, event_id, event_date, category, tier, place, field, source)
  select athlete_key(x.last_name, x.first_name), x.last_name || ', ' || x.first_name, null, null,
         x.event_id, e.event_date, e.category, e.tier, x.place, e.entrants, 'official'
  from usaf_event_results x
  join usaf_events e on e.event_id = x.event_id
  where x.place is not null and x.place > 0 and e.event_date is not null
  on conflict (athlete_key, event_id) do update
    set place = excluded.place, field = excluded.field, source = 'official';
  -- Field size where the page did not say: the athletes we know of.
  update athlete_results a set field = c.n
  from (select event_id, count(*) n from athlete_results group by event_id) c
  where c.event_id = a.event_id and (a.field is null or a.field < c.n);
  select count(*) into n from athlete_results;
  return n;
end $$;

-- Replay every event in date order and rate everyone.
create or replace function rebuild_athlete_ratings(p_k double precision default 48)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ev record;
  n_events integer := 0;
  cal record;
begin
  -- Float math on purpose: numeric power() with fractional exponents is a
  -- thousand times slower and turned a one-second replay into minutes.
  drop table if exists _r; drop table if exists _p;
  create temp table _r (athlete_key text primary key, rating double precision not null default 1500, games integer not null default 0, last_event date) on commit drop;
  insert into _r (athlete_key) select distinct athlete_key from athlete_results;
  create temp table _p (athlete_key text primary key, rating double precision, s double precision, e double precision, games integer, n integer) on commit drop;

  for ev in select event_id, event_date, count(*) as n from athlete_results group by event_id, event_date having count(*) >= 4 order by event_date, event_id loop
    delete from _p;
    -- Share of the known field beaten (1 = won, 0 = last), by position among known placings.
    insert into _p (athlete_key, rating, s, games, n)
    select a.athlete_key, r.rating,
           (ev.n - row_number() over (order by a.place, a.athlete_key))::double precision / greatest(1, ev.n - 1),
           r.games, ev.n
    from athlete_results a join _r r on r.athlete_key = a.athlete_key
    where a.event_id = ev.event_id;
    -- Expected share: mean win probability against each other known entrant.
    update _p p set e = q.e
    from (select p1.athlete_key, avg(1.0 / (1.0 + power(10.0::double precision, (p2.rating - p1.rating) / 400.0))) as e
          from _p p1 join _p p2 on p2.athlete_key <> p1.athlete_key
          group by p1.athlete_key) q
    where q.athlete_key = p.athlete_key;
    -- Newer athletes move more; bigger fields say more.
    update _r r set rating = r.rating + p_k * (1.0 + 1.0 / (1.0 + p.games)) * least(2.0, sqrt(p.n / 16.0)) * (p.s - p.e),
                    games = r.games + 1, last_event = ev.event_date
    from _p p where p.athlete_key = r.athlete_key and p.e is not null;
    n_events := n_events + 1;
  end loop;

  delete from athlete_ratings;
  insert into athlete_ratings (athlete_key, name, yob, member_id, rating, games, last_event)
  select r.athlete_key, m.name, m.yob, m.member_id, round(r.rating::numeric, 1), r.games, r.last_event
  from _r r
  left join lateral (select name, yob, member_id from athlete_results a where a.athlete_key = r.athlete_key order by (member_id is null), (yob is null), event_date desc limit 1) m on true
  where r.games > 0;

  -- Fit the scale to the strength numbers the app already shows, on athletes
  -- with a few events and a real strength (under 500 is a placeholder there).
  update athlete_ratings ar set ft_strength = f.strength_de
  from (select distinct on (athlete_key_from_name(name)) athlete_key_from_name(name) as k, strength_de
        from ft_event_entrants order by athlete_key_from_name(name), fetched_at desc) f
  where f.k = ar.athlete_key;
  select regr_slope(ft_strength, rating) as slope, regr_intercept(ft_strength, rating) as intercept,
         regr_count(ft_strength, rating) as n, regr_r2(ft_strength, rating) as r2
    into cal
  from athlete_ratings where ft_strength is not null and ft_strength >= 500 and games >= 3;
  if cal.n >= 20 and cal.slope > 0 then
    update athlete_ratings set strength_est = round(cal.intercept + cal.slope * rating);
  else
    update athlete_ratings set strength_est = round(rating);
  end if;
  insert into rating_calibration (id, slope, intercept, n, r2, k, events, athletes, updated_at)
  values (1, cal.slope, cal.intercept, cal.n, cal.r2, p_k, n_events, (select count(*) from athlete_ratings), now())
  on conflict (id) do update set slope = excluded.slope, intercept = excluded.intercept, n = excluded.n, r2 = excluded.r2, k = excluded.k, events = excluded.events, athletes = excluded.athletes, updated_at = now();
  return jsonb_build_object('events', n_events, 'athletes', (select count(*) from athlete_ratings), 'calibrated_on', cal.n, 'slope', round(cal.slope::numeric, 3), 'intercept', round(cal.intercept::numeric, 1), 'r2', round(cal.r2::numeric, 3));
end $$;

-- One call for the app and the reader: parents only.
create or replace function refresh_ratings()
returns jsonb language plpgsql security definer set search_path = public as $$
declare rows_n integer; out jsonb;
begin
  if not (is_parent() or current_user in ('service_role', 'postgres')) then
    raise exception 'parents only';
  end if;
  rows_n := rebuild_athlete_results();
  out := rebuild_athlete_ratings();
  return out || jsonb_build_object('placings', rows_n);
end $$;
revoke all on function refresh_ratings() from public;
grant execute on function refresh_ratings() to authenticated, service_role;
revoke all on function rebuild_athlete_results() from public;
revoke all on function rebuild_athlete_ratings(double precision) from public;

-- Nightly backstop: the ratings follow whatever was read during the day.
select cron.unschedule(jobid) from cron.job where jobname = 'refresh-ratings-nightly';
select cron.schedule('refresh-ratings-nightly', '20 10 * * *', $$select public.refresh_ratings()$$);
