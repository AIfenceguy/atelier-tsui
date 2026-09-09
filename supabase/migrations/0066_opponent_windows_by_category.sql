-- Placings read per category. A Y14 podium and a Division I filler finish are
-- two different stories; the roster must tell them apart (Ricky, 2026-09-09).
-- Applied 2026-09-09.
create or replace view opponent_windows_by_category with (security_invoker = on) as
with w as (select unnest(array[90, 180, 270, 365]) as days),
r as (
  select o.tracker_id, o.result_date, o.category, o.place, o.field_size, o.event_class,
         round(100.0 * o.place::numeric / nullif(o.field_size, 0)::numeric, 1) as pct,
         implied_performance(o.category, o.place, o.field_size) as implied
  from opponent_results o where o.category is not null),
scoped as (
  select w.days, r.*, (r.result_date >= current_date - w.days / 2) as recent_half
  from w join r on r.result_date >= current_date - w.days)
select tracker_id, category, days as window_days, count(*) as events,
  round(percentile_cont(0.5) within group (order by pct::double precision))::int as median_pct,
  min(pct)::int as best_pct, max(pct)::int as worst_pct,
  round(100.0 * count(*) filter (where field_size >= 100) / count(*))::int as pct_big_fields,
  round(percentile_cont(0.5) within group (order by pct::double precision) filter (where field_size >= 100))::int as median_pct_big,
  round(percentile_cont(0.5) within group (order by pct::double precision) filter (where field_size < 100))::int as median_pct_small,
  round(avg(implied) filter (where implied is not null))::int as implied_form,
  (round(percentile_cont(0.5) within group (order by pct::double precision) filter (where recent_half))
   - round(percentile_cont(0.5) within group (order by pct::double precision) filter (where not recent_half)))::int as trend_pct,
  current_date - max(result_date) as days_since_last
from scoped group by tracker_id, category, days;

create or replace view opponent_flags_by_category with (security_invoker = on) as
with w90 as (select * from opponent_windows_by_category where window_days = 90),
w180 as (select * from opponent_windows_by_category where window_days = 180),
w365 as (select * from opponent_windows_by_category where window_days = 365),
anyl as (select tracker_id, min(days_since_last) as days_since_last from w365 group by tracker_id)
select p.tracker_id, p.name, w365.category,
  array_remove(array[
    case when anyl.days_since_last >= 60 then 'rusty:' || anyl.days_since_last || ' days since his last event anywhere' end,
    case when w365.days_since_last >= 120 and anyl.days_since_last < 60 then 'not here lately:' || w365.days_since_last || ' days since his last event in this category' end,
    case when w365.median_pct_big is not null and w365.median_pct_small is not null and (w365.median_pct_big - w365.median_pct_small) >= 15
         then 'fades in deep fields:median ' || w365.median_pct_small || '% in small fields vs ' || w365.median_pct_big || '% in fields of 100+' end,
    case when w180.trend_pct >= 12 then 'form dropping:median finish worsened ' || w180.trend_pct || ' points over six months' end,
    case when w180.trend_pct <= -12 then 'form rising:median finish improved ' || abs(w180.trend_pct) || ' points over six months' end,
    case when w365.events >= 5 and (w365.worst_pct - w365.best_pct) >= 60 then 'erratic:finishes span ' || w365.best_pct || '% to ' || w365.worst_pct || '% in this category' end,
    case when w90.events >= 4 then 'heavy schedule:' || w90.events || ' events here in 90 days' end,
    case when w365.events between 1 and 2 then 'thin record:only ' || w365.events || ' event' || case when w365.events > 1 then 's' else '' end || ' here in a year' end
  ], null) as flags,
  w90.events as events_90, w90.median_pct as median_90, w180.median_pct as median_180, w365.median_pct as median_365,
  w365.best_pct as best_365, w365.worst_pct as worst_365, w365.events as events_365, w180.trend_pct, w365.days_since_last, w365.implied_form
from opponent_profiles p
join w365 on w365.tracker_id = p.tracker_id
left join w180 on w180.tracker_id = p.tracker_id and w180.category = w365.category
left join w90 on w90.tracker_id = p.tracker_id and w90.category = w365.category
left join anyl on anyl.tracker_id = p.tracker_id;

revoke all on opponent_windows_by_category, opponent_flags_by_category from anon;
grant select on opponent_windows_by_category, opponent_flags_by_category to authenticated;
