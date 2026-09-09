// refresh-due — the daily job. Finds every event a member has registered, or
// that is on the season calendar within the next 60 days, whose field has not
// been read in the last 23 hours, and refreshes a few of them by calling
// refresh-event with the service key. Called by pg_cron every 3 minutes in a
// four-hour night window, so a busy calendar converges without any one call
// running long.
//
// Only the cron job may call it: it sends the shared secret that lives in the
// app_secrets table (generated inside the database, never in git), or the
// service key for a manual run. Anyone else gets 403, so nobody can make this
// project hammer FencingTracker on our name.

import { createClient } from "npm:@supabase/supabase-js@2";

// Each refresh-event call reads at most 60 pages (about 40 s). Two per run keeps
// a run under the function's wall clock; pg_cron calls every 3 minutes in the
// night window, so a night is ~160 batches. After the first pass the 7-day
// snapshot cache makes a daily refresh one page per event plus new entrants.
const CALLS_PER_RUN = 2;
const HORIZON_DAYS = 60;

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, serviceKey);

  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${serviceKey}`) {
    const given = req.headers.get("x-cron-secret") || "";
    const { data: s } = await db.from("app_secrets").select("value").eq("name", "cron_secret").maybeSingle();
    if (!given || !s?.value || given !== s.value) {
      return new Response(JSON.stringify({ error: "not allowed" }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 864e5).toISOString().slice(0, 10);

  const [{ data: mine }, { data: cal }, { data: done }] = await Promise.all([
    db.from("member_events").select("ft_event_id,event_date").not("ft_event_id", "is", null),
    db.from("season_events").select("ft_event_id,start_date").not("ft_event_id", "is", null).gte("start_date", today).lte("start_date", horizon),
    db.from("event_refresh").select("ft_event_id,last_refreshed_at,partial"),
  ]);
  const recent = new Map((done || []).map((r) => [Number(r.ft_event_id), r]));
  // Members' own events first, then the calendar by date.
  const order = new Map<number, string>();
  for (const c of cal || []) order.set(Number(c.ft_event_id), "1" + c.start_date);
  for (const m of mine || []) if (!m.event_date || m.event_date >= today) order.set(Number(m.ft_event_id), "0" + (m.event_date || today));
  const todo = [...order.keys()].filter((id) => {
    const r = recent.get(id);
    if (!r || !r.last_refreshed_at) return true;
    const age = now.getTime() - new Date(r.last_refreshed_at).getTime();
    if (age < 4 * 60e3) return false;   // another run is on it right now
    return r.partial || age > 23 * 3600e3;
  }).sort((a, b) => String(order.get(a)).localeCompare(String(order.get(b))));

  const { data: run } = await db.from("refresh_runs").insert({ events_due: todo.length }).select().single();
  let doneCount = 0, pages = 0, calls = 0;
  const notes: string[] = [];
  for (const id of todo) {
    if (calls >= CALLS_PER_RUN) break;
    const r = await fetch(`${url}/functions/v1/refresh-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey },
      body: JSON.stringify({ ft_event_id: id }),
    });
    calls += 1;
    const j = await r.json().catch(() => ({}));
    pages += Number(j.pages || 0);
    if (!r.ok || j.error) { notes.push(`${id}: ${j.error || r.status}`); continue; }
    if (!j.partial) doneCount += 1;
  }
  if (run) await db.from("refresh_runs").update({ finished_at: new Date().toISOString(), events_done: doneCount, pages, note: notes.join(" | ") || null }).eq("id", run.id);
  return new Response(JSON.stringify({ due: todo.length, done: doneCount, pages, remaining: Math.max(0, todo.length - doneCount), notes }), { headers: { "Content-Type": "application/json" } });
});
