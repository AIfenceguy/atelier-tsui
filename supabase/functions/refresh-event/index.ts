// refresh-event — read one FencingTracker event's entry list and, for each
// entrant whose snapshot is stale, their profile (results) and strength
// (DE and pool over time) pages, on demand, and cache the result.
//
// This is the only place the app reads fencingtracker.com. It runs when a
// member registers an event and once a day for events already registered,
// never across the site:
//   - identifies itself in the User-Agent,
//   - waits 350 ms between requests,
//   - keeps a 7-day cache per fencer and refreshes an event at most once a day,
//   - reads at most 60 pages per call and tells the caller to call again.
// robots.txt on fencingtracker.com allows all agents (checked 2026-09-08).

import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "EnGardeInsight/1.0 (+https://aifenceguy.github.io/en-garde-tsui; on-demand, cached)";
const DELAY_MS = 350;
const MAX_PAGES = 60;
const FRESH_DAYS = 7;
const EVENT_REFRESH_HOURS = 23;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s: string) =>
  s.replace(/<[^>]+>/g, " ").replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

async function page(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html" } });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return await r.text();
}

type Entrant = { tracker_id: number; name: string; club: string | null; rating: string | null; strength_de: number | null; list_pos: number };

function parseEntrants(html: string): { title: string; date: string | null; entrants: Entrant[] } {
  const title = clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, ""])[1]);
  let date = (html.match(/\b(20\d\d-\d\d-\d\d)\b/) || [])[1] || null;
  if (!date) {
    const m = html.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d\d)\b/);
    if (m) { const d = new Date(`${m[1]} ${m[2]}, ${m[3]} UTC`); if (!isNaN(d.getTime())) date = d.toISOString().slice(0, 10); }
  }
  const entrants: Entrant[] = [];
  const seen = new Set<number>();   // the page lists some fencers twice (two tables)
  let pos = 0;
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = m[1];
    const link = row.match(/href="\/p\/(\d+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const id = Number(link[1]);
    if (seen.has(id)) continue;
    seen.add(id); pos += 1;
    const nums = [...row.matchAll(/<td[^>]*>\s*(\d{3,4})\s*<\/td>/g)].map((x) => Number(x[1]));
    const club = row.match(/href="\/club\/\d+\/[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const rating = row.match(/<td class="d-none d-sm-table-cell">\s*([A-EU]\d{0,2})\s*<\/td>/);
    entrants.push({ tracker_id: id, name: clean(link[2]), club: club ? clean(club[1]) : null, rating: rating ? rating[1] : null, strength_de: nums.length ? nums[0] : null, list_pos: pos });
  }
  return { title, date, entrants };
}

// DE and pool strength over time from the strength page's chart data.
function parseStrength(html: string, today: Date) {
  const m = html.match(/F:\s*\{\s*P:\s*\[([\s\S]*?)\],\s*D:\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  const pts = (s: string) => [...s.matchAll(/"x":\s*"(\d{4}-\d{2}-\d{2})",\s*"y":\s*(\d+)/g)].map((x) => ({ x: x[1], y: Number(x[2]) }));
  const P = pts(m[1]), D = pts(m[2]);
  if (!D.length) return null;
  const cut = (days: number) => new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);
  const at = (arr: { x: string; y: number }[], days: number) => { const p = arr.filter((q) => q.x <= cut(days)); return p.length ? p[p.length - 1].y : null; };
  // Foil only: the page's summary rows list every weapon the fencer has, and
  // the first "Direct elimination" row can be epee. The F series is foil.
  return {
    strength_de: D[D.length - 1].y,
    strength_pool: P.length ? P[P.length - 1].y : null,
    de_now: D[D.length - 1].y, de_90d: at(D, 90), de_180d: at(D, 180), de_365d: at(D, 365),
    pool_now: P.length ? P[P.length - 1].y : null, pool_90d: at(P, 90), pool_180d: at(P, 180),
    events_90d: D.filter((p) => p.x >= cut(90)).length, events_180d: D.filter((p) => p.x >= cut(180)).length,
    last_event: D[D.length - 1].x, peak_de: Math.max(...D.map((p) => p.y)),
  };
}

// Placings from the profile page's rating-history table: the last 12 months.
function parseResults(html: string, today: Date) {
  const re = /<tr data-ranking-search="[^"]*">\s*<td class="ranking-table__numeric" data-ranking-value="(\d{8})">[^<]*<\/td>\s*<td>([^<]*)<\/td>\s*<td class="person-summary__event-cell">\s*<a href="\/event\/\d+\/results" title="([^"]*)">[^<]*<\/a>\s*<\/td>\s*<td class="ranking-table__numeric" data-ranking-value="\d+">\s*(\d+)\s*\/\s*(\d+)\s*<\/td>/g;
  const rows: { d: string; event: string; place: number; field: number }[] = [];
  for (const m of html.matchAll(re)) {
    const d = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}`;
    rows.push({ d, event: clean(m[3]).slice(0, 60), place: Number(m[4]), field: Number(m[5]) });
  }
  const cut = (days: number) => new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);
  const win = (days: number) => {
    const w = rows.filter((r) => r.d >= cut(days) && r.field > 0).map((r) => r.place / r.field).sort((a, b) => a - b);
    if (!w.length) return { n: 0, median: null, best: null };
    return { n: w.length, median: +w[Math.floor(w.length / 2)].toFixed(3), best: +w[0].toFixed(3) };
  };
  const w90 = win(90), w180 = win(180);
  return {
    results_90d: w90.n, median_pct_90d: w90.median, best_pct_90d: w90.best,
    results_180d: w180.n, median_pct_180d: w180.median, best_pct_180d: w180.best,
    history_json: rows.filter((r) => r.d >= cut(365)).slice(0, 40),
  };
}

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  // A signed-in member, or the service key (the daily job and maintenance scripts).
  const auth = req.headers.get("Authorization") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  let userId: string | null = null;
  if (auth !== `Bearer ${serviceKey}`) {
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: who } = await anon.auth.getUser();
    if (!who?.user) return json({ error: "sign in first" }, 401);
    userId = who.user.id;
  }

  const body = await req.json().catch(() => ({}));
  const ftEventId = Number(body.ft_event_id);
  const force = Boolean(body.force);
  if (!ftEventId) return json({ error: "ft_event_id required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const now = new Date();

  const { data: prev } = await db.from("event_refresh").select("*").eq("ft_event_id", ftEventId).maybeSingle();
  const prevAt = prev?.last_refreshed_at ? new Date(prev.last_refreshed_at) : null;
  if (!force && prevAt && !prev.partial && now.getTime() - prevAt.getTime() < EVENT_REFRESH_HOURS * 3600e3) {
    return json({ cached: true, ...prev });
  }

  let pages = 0;
  try {
    const html = await page(`https://fencingtracker.com/event/${ftEventId}`); pages += 1;
    const { title, date, entrants } = parseEntrants(html);
    const writeErrors: string[] = [];
    if (entrants.length) {
      const del = await db.from("ft_event_entrants").delete().eq("ft_event_id", ftEventId);
      if (del.error) writeErrors.push("entrants delete: " + del.error.message);
      const ins = await db.from("ft_event_entrants").upsert(entrants.map((e) => ({ ft_event_id: ftEventId, ...e, fetched_at: now.toISOString() })));
      if (ins.error) writeErrors.push("entrants write: " + ins.error.message);
    }

    // Two pages per stale fencer: profile (placings) and strength (DE + pool over time).
    const ids = entrants.map((e) => e.tracker_id);
    const { data: fresh } = await db.from("fencer_snapshot").select("tracker_id,fetched_at,results_180d").in("tracker_id", ids);
    const freshSet = new Set((fresh || [])
      .filter((f) => f.results_180d != null && now.getTime() - new Date(f.fetched_at).getTime() < FRESH_DAYS * 864e5)
      .map((f) => Number(f.tracker_id)));
    const stale = entrants.filter((e) => !freshSet.has(e.tracker_id));
    let fetched = 0, partial = false;
    for (const e of stale) {
      if (pages + 2 > MAX_PAGES) { partial = true; break; }
      const row: Record<string, unknown> = { tracker_id: e.tracker_id, name: e.name, club: e.club, rating: e.rating, strength_de: e.strength_de, fetched_at: now.toISOString() };
      try {
        await sleep(DELAY_MS);
        const ph = await page(`https://fencingtracker.com/p/${e.tracker_id}/x`); pages += 1;
        Object.assign(row, parseResults(ph, now));
        const by = ph.match(/person-hero__birth-year">(\d{4})</);
        if (by) row.birth_year = Number(by[1]);
      } catch (_) { /* profile page missing: keep the entry-list strength */ }
      try {
        await sleep(DELAY_MS);
        const sh = await page(`https://fencingtracker.com/p/${e.tracker_id}/x/strength`); pages += 1;
        const s = parseStrength(sh, now);
        if (s) Object.assign(row, s);
      } catch (_) { /* strength page missing */ }
      delete row.birth_year;   // not a snapshot column yet
      const up = await db.from("fencer_snapshot").upsert(row);
      if (up.error) writeErrors.push(`snapshot ${e.tracker_id}: ${up.error.message}`); else fetched += 1;
    }
    const summary = {
      ft_event_id: ftEventId, title, event_date: date, entrants: entrants.length,
      snapshots_fresh: freshSet.size + fetched, partial: partial || writeErrors.length > 0, requested_by: userId,
      last_refreshed_at: now.toISOString(), last_error: writeErrors.length ? writeErrors.slice(0, 3).join(" | ") : null,
    };
    await db.from("event_refresh").upsert(summary);
    return json({ cached: false, pages, fetched, write_errors: writeErrors, ...summary });
  } catch (err) {
    const msg = String((err as Error).message || err);
    await db.from("event_refresh").upsert({ ft_event_id: ftEventId, requested_by: userId, last_error: msg, last_refreshed_at: now.toISOString(), partial: true });
    return json({ error: msg, pages }, 502);
  }
});
