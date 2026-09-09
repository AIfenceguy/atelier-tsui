-- A placing in a higher category, translated onto the target category's scale.
-- The source placing becomes an implied strength through the source category's
-- reference bands; that strength is then placed in the target category's
-- reference field. Only upward (Cadet -> Y14, Junior -> Y14); a lower category
-- (Y12 -> Y14) returns null and never counts. A category with no reference
-- bands (Division I today) also returns null: listed, never scaled.
-- Applied 2026-09-09 (Ricky: "it should be an upward scale, not downward").
create or replace function equiv_pct(p_target text, p_cat text, p_place integer, p_field integer)
returns numeric language sql stable set search_path = public as $$
  with ranks as (
    select c, r from unnest(array['y8','y10','y12','y14','cadet','junior','div3','div2','div1','senior','vet']) with ordinality as x(c, r)),
  t as (select r from ranks where c = lower(p_target)),
  s as (select r from ranks where c = lower(p_cat)),
  implied as (select implied_performance(lower(p_cat), p_place, p_field) as v),
  ref as (select finish_lo, finish_hi, avg_strength, (select max(field_size) from event_strength_bands where is_reference and lower(category) = lower(p_target)) as field
          from event_strength_bands where is_reference and lower(category) = lower(p_target))
  select case
    when lower(p_cat) = lower(p_target) then round(100.0 * p_place / nullif(p_field, 0), 1)
    when (select r from s) > (select r from t) and (select v from implied) is not null then coalesce(
      (select round(100.0 * ((finish_lo + finish_hi) / 2.0) / field, 1) from ref where avg_strength <= (select v from implied) order by finish_lo limit 1),
      (select round(100.0 * ((finish_lo + finish_hi) / 2.0) / field, 1) from ref order by finish_lo limit 1))
    else null end;
$$;

-- Windows for one target category: the target's own placings (weight 1) and
-- higher categories translated up (weight 1/2), as a weighted median, beside
-- the target-only median so the two can be shown apart.
create or replace function opponent_windows_for(p_target text)
returns table(tracker_id integer, window_days integer, events integer, events_scaled integer, median_pct integer, median_same integer, best_same integer, worst_same integer, days_since_same integer)
language sql stable set search_path = public as $$
  with w as (select unnest(array[90, 180, 270, 365]) as days),
  r as (
    select o.tracker_id, o.result_date, equiv_pct(p_target, o.category, o.place, o.field_size) as pct,
           lower(o.category) = lower(p_target) as same
    from opponent_results o where o.category is not null),
  scoped as (
    select w.days, r.tracker_id, r.result_date, r.pct, r.same, case when r.same then 1.0 else 0.5 end as wt
    from w join r on r.result_date >= current_date - w.days where r.pct is not null),
  ordered as (
    select *, sum(wt) over (partition by tracker_id, days order by pct, result_date rows between unbounded preceding and current row) as cum,
           sum(wt) over (partition by tracker_id, days) as tot
    from scoped)
  select tracker_id, days,
    count(*) filter (where same)::int,
    count(*) filter (where not same)::int,
    round(min(pct) filter (where cum >= tot / 2))::int,
    round(percentile_cont(0.5) within group (order by pct::double precision) filter (where same))::int,
    round(min(pct) filter (where same))::int,
    round(max(pct) filter (where same))::int,
    (current_date - max(result_date) filter (where same))::int
  from ordered group by tracker_id, days;
$$;
revoke all on function equiv_pct(text, text, integer, integer), opponent_windows_for(text) from public, anon;
grant execute on function equiv_pct(text, text, integer, integer), opponent_windows_for(text) to authenticated;
