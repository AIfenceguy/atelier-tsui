-- Parent is the master login; kids see only their own fencer; parents decide
-- whether kids can see competition planning, the flight tracker, and costs.
-- Applied to kyfkiigbiwhczrtnlivc on 2026-09-09.
alter table household
    add column if not exists kids_see_season boolean not null default true,
    add column if not exists kids_see_travel boolean not null default false,
    add column if not exists kids_see_costs  boolean not null default false;

-- Am I a parent (I own at least one profile)?
create or replace function is_parent() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where owner_user_id = auth.uid());
$$;
-- The household I belong to: as owner, or through the profile my login is attached to.
create or replace function my_household_owner() returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select owner_user_id from profiles where owner_user_id = auth.uid() limit 1),
    (select owner_user_id from profiles where login_user_id = auth.uid() limit 1));
$$;
-- What a kid's login may see, per the parent's settings. Parents may see everything.
create or replace function kid_can(p_feature text) returns boolean language sql stable security definer set search_path = public as $$
  select is_parent() or exists (
    select 1 from household h
    where h.owner_user_id = my_household_owner()
      and case p_feature when 'season' then h.kids_see_season when 'travel' then h.kids_see_travel when 'costs' then h.kids_see_costs else false end);
$$;
-- One call the app makes at boot.
create or replace function my_visibility() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'is_parent', is_parent(),
    'see_season', kid_can('season'),
    'see_travel', kid_can('travel'),
    'see_costs',  kid_can('costs'));
$$;
grant execute on function is_parent(), my_household_owner(), kid_can(text), my_visibility() to authenticated;

-- Enforce in the database. Competition planning:
drop policy if exists season_events_read on season_events;
create policy season_events_read on season_events for select to authenticated using (kid_can('season'));
drop policy if exists member_events_rw on member_events;
create policy member_events_rw on member_events for all to authenticated
    using (profile_belongs_to_me(profile_id) and kid_can('season')) with check (profile_belongs_to_me(profile_id) and is_parent());
drop policy if exists peers_rw on peers;
create policy peers_rw on peers for all to authenticated
    using (profile_belongs_to_me(profile_id) and kid_can('season')) with check (profile_belongs_to_me(profile_id) and kid_can('season'));
drop policy if exists fencer_goals_rw on fencer_goals;
create policy fencer_goals_rw on fencer_goals for all to authenticated
    using (profile_belongs_to_me(profile_id)) with check (profile_belongs_to_me(profile_id) and is_parent());
-- Costs: the household (home, hotel rate) is only needed for pricing.
drop policy if exists household_own on household;
create policy household_own on household for all to authenticated
    using (owner_user_id = auth.uid() or (owner_user_id = my_household_owner() and kid_can('costs')))
    with check (owner_user_id = auth.uid());
-- Flights: parent, or a kid the parent has allowed.
do $$ begin
  if exists (select 1 from pg_tables where tablename = 'flight_watches') then
    execute 'drop policy if exists flight_watches_kid_gate on flight_watches';
    execute 'create policy flight_watches_kid_gate on flight_watches as restrictive for select to authenticated using (kid_can(''travel''))';
  end if;
  if exists (select 1 from pg_tables where tablename = 'flight_prices') then
    execute 'drop policy if exists flight_prices_kid_gate on flight_prices';
    execute 'create policy flight_prices_kid_gate on flight_prices as restrictive for select to authenticated using (kid_can(''travel''))';
  end if;
end $$;
