-- Lost bouts logged from the FencingTracker results. An opponent carries the
-- tracker id so every meeting with the same fencer lands on one record; a
-- logged bout remembers which result row it came from so it is never offered
-- twice. Applied 2026-09-09.
alter table opponents add column if not exists tracker_id integer;
create index if not exists opponents_tracker_idx on opponents (profile_id, tracker_id);
alter table bouts add column if not exists source_bout_id uuid references fencer_bouts(id) on delete set null;
create index if not exists bouts_source_idx on bouts (source_bout_id);

-- Backfill what was logged by hand: a bout on the same day with the same score
-- as exactly one result row is that bout. Only empty fields are filled.
with m as (
  select b.id as bout_id, min(f.id::text)::uuid as fb_id, min(f.opponent_tracker_id) as tid, count(*) as n
  from bouts b join fencer_bouts f on f.profile_id = b.profile_id and f.bout_date = b.date
       and f.score_for = b.my_score and f.score_against = b.their_score
  where b.deleted_at is null group by b.id having count(*) = 1)
update bouts b set opponent_tracker_id = coalesce(b.opponent_tracker_id, m.tid), source_bout_id = coalesce(b.source_bout_id, m.fb_id),
  context = case when b.context in ('club_open', 'other') or b.context is null then (case when greatest(b.my_score, b.their_score) > 5 then 'de' else 'pool' end) else b.context end
from m where b.id = m.bout_id;
update opponents o set tracker_id = s.tid from (select opponent_id, min(opponent_tracker_id) as tid from bouts where opponent_tracker_id is not null and deleted_at is null group by opponent_id) s
  where o.id = s.opponent_id and o.tracker_id is null;
update opponents o set club = coalesce(o.club, fs.club), rating = coalesce(o.rating, fs.rating) from fencer_snapshot fs where fs.tracker_id = o.tracker_id;
update bouts b set opponent_club = coalesce(b.opponent_club, fs.club), opponent_rating = coalesce(b.opponent_rating, fs.rating) from fencer_snapshot fs where fs.tracker_id = b.opponent_tracker_id and b.deleted_at is null;
