-- A parent imports or refreshes USA Fencing standings: the ranking snapshot,
-- the household's standings rows, and the marks. Applied 2026-09-10.
drop policy if exists usaf_rankings_parent_write on usaf_rankings;
create policy usaf_rankings_parent_write on usaf_rankings for all to authenticated using (is_parent()) with check (is_parent());
drop policy if exists fencer_standings_parent_write on fencer_standings;
create policy fencer_standings_parent_write on fencer_standings for all to authenticated using (is_parent() and profile_belongs_to_me(profile_id)) with check (is_parent() and profile_belongs_to_me(profile_id));
drop policy if exists standings_marks_parent_write on standings_marks;
create policy standings_marks_parent_write on standings_marks for all to authenticated using (is_parent()) with check (is_parent());
grant insert, update, delete on usaf_rankings, fencer_standings, standings_marks to authenticated;
