// refresh-peer — read one fencer's public FencingTracker record: profile
// (club, rating, birth year, last twelve months of results), registrations,
// and current DE / pool strength. On demand, two pages, cached three days.
// Same manners as refresh-event: identified, slow, never across the site.
//
// Two homes for the answer: peer_snapshot (the Season screen's "fencers to
// watch") and the opponent_profiles / opponent_results pair that the Insight
// screen's windows and flags are computed from. Both are written on every
// read, so a fencer is never "66 days since last event" a week after he
// fenced the boys.

import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "EnGardeInsight/1.0 (+https://aifenceguy.github.io/en-garde-tsui; on-demand, cached)";
const DELAY_MS = 400;
const FRESH_HOURS = 72;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s: string) =>
  s.replace(/<[^>]+>/g, " ").replace(/&#39;|&apos;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

async function page(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html" } });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return await r.text();
}

// Event title -> the category key the strength bands and windows use.
const CATS: [RegExp, string][] = [
  [/\by-?8\b/, "y8"], [/\by-?10\b/, "y10"], [/\by-?12\b/, "y12"], [/\by-?14\b/, "y14"],
  [/cadet/, "cadet"], [/junior/, "junior"],
  [/div(?:ision)?\s*iii\b|div(?:ision)?\s*3\b/, "div3"], [/div(?:ision)?\s*ii\b|div(?:ision)?\s*2\b/, "div2"],
  [/div(?:ision)?\s*ia?\b|div(?:ision)?\s*1a?\b/, "div1"], [/veteran|\bvet\b/, "vet"], [/senior|\bopen\b/, "senior"],
];
function catOf(title: string): string {
  const t = String(title || "").toLowerCase();
  for (const [re, v] of CATS) if (re.test(t)) return v;
  return t.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "other";
}

type Result = { d: string; tournament: string; event: string; place: number; field: number; earned?: string | null; cls?: string | null; category?: string };

function parseProfile(html: string, today: Date) {
  const name = clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, ""])[1]).replace(/\s*Verified\s*$/i, "");
  const by = html.match(/person-hero__birth-year">(\d{4})</);
  const club = html.match(/person-hero__club-link"[^>]*>([^<]+)</);
  // Rating rows carry a search attribute like 'ratingFoil B26 Mar 18, 2026'.
  const rm = html.match(/data-ranking-search="rating(?:Foil|Épée|Epee|Saber|Sabre)\s+([A-EU]\d{0,2})/);
  const rating = rm ? rm[1] : null;
  // Results rows: date, tournament, event, place/field, then (when present)
  // the rating earned and the event class, as the old scraper read them.
  const re = /<tr data-ranking-search="[^"]*">\s*<td class="ranking-table__numeric" data-ranking-value="(\d{8})">[^<]*<\/td>\s*<td>([^<]*)<\/td>\s*<td class="person-summary__event-cell">\s*<a href="\/event\/\d+\/results" title="([^"]*)">[^<]*<\/a>\s*<\/td>\s*<td class="ranking-table__numeric" data-ranking-value="\d+">\s*(\d+)\s*\/\s*(\d+)\s*<\/td>(?:\s*<td data-ranking-text="([^"]*)">[^<]*<\/td>\s*<td data-ranking-text="([^"]*)">)?/g;
  const cut = new Date(today.getTime() - 365 * 864e5).toISOString().slice(0, 10);
  const results: Result[] = [];
  for (const m of html.matchAll(re)) {
    const d = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}`;
    if (d < cut) continue;
    const event = clean(m[3]).slice(0, 40);
    results.push({ d, tournament: clean(m[2]).slice(0, 60), event, place: Number(m[4]), field: Number(m[5]), earned: m[6] ? clean(m[6]) || null : null, cls: m[7] ? clean(m[7]) || null : null, category: catOf(event) });
  }
  return { name, birth_year: by ? Number(by[1]) : null, club: club ? clean(club[1]) : null, rating, results: results.slice(0, 60) };
}

function parseStrength(html: string) {
  const m = html.match(/F:\s*\{\s*P:\s*\[([\s\S]*?)\],\s*D:\s*\[([\s\S]*?)\]/);
  if (!m) return {};
  const last = (s: string) => { const pts = [...s.matchAll(/"y":\s*(\d+)/g)]; return pts.length ? Number(pts[pts.length - 1][1]) : null; };
  return { strength_de: last(m[2]), strength_pool: last(m[1]) };
}

// Keep the Insight tables in step with what was read.
// deno-lint-ignore no-explicit-any
async function syncOpponent(db: any, tid: number, row: any) {
  try {
    await db.from("opponent_profiles").upsert({
      tracker_id: tid, name: row.name || null, club: row.club || null, birth_year: row.birth_year || null, rating: row.rating || null,
      strength_de: row.strength_de ?? null, strength_pool: row.strength_pool ?? null,
      tracker_url: `https://fencingtracker.com/p/${tid}/x`, fetched_at: row.fetched_at || new Date().toISOString(),
    });
    const res: Result[] = Array.isArray(row.results) ? row.results : [];
    if (res.length) {
      const oldest = res.reduce((m, r) => (r.d < m ? r.d : m), res[0].d);
      await db.from("opponent_results").delete().eq("tracker_id", tid).gte("result_date", oldest);
      const rows = res.map((r) => ({
        tracker_id: tid, result_date: r.d, tournament: r.tournament, category: r.category || catOf(r.event), event_title: r.event,
        place: r.place, field_size: r.field, event_class: r.cls || null, rating_earned: r.earned || null,
      }));
      await db.from("opponent_results").upsert(rows, { onConflict: "tracker_id,result_date,tournament,category", ignoreDuplicates: true });
    }
  } catch (e) { console.warn("opponent sync failed", e); }
}

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  // A signed-in member, the service key, or a server-side job carrying the
  // cron secret from app_secrets.
  const auth = req.headers.get("Authorization") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  let allowed = auth === `Bearer ${serviceKey}`;
  if (!allowed) {
    const given = req.headers.get("x-cron-secret") || "";
    if (given) {
      const { data: s } = await db.from("app_secrets").select("value").eq("name", "cron_secret").maybeSingle();
      allowed = Boolean(s?.value) && given === s.value;
    }
  }
  if (!allowed) {
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: who } = await anon.auth.getUser();
    if (!who?.user) return json({ error: "sign in first" }, 401);
  }
  const body = await req.json().catch(() => ({}));
  // A batch (tracker_ids) is read one fencer at a time with the same pause
  // between pages, capped so one call stays inside the function's clock.
  if (Array.isArray(body.tracker_ids)) {
    const ids = [...new Set(body.tracker_ids.map(Number).filter(Boolean))].slice(0, 12);
    const out: Record<string, string> = {};
    for (const id of ids) {
      out[String(id)] = await readOne(db, id, Boolean(body.force));
      await sleep(DELAY_MS);
    }
    return json({ read: ids.length, results: out });
  }
  const tid = Number(body.tracker_id);
  if (!tid) return json({ error: "tracker_id required" }, 400);

  const now = new Date();
  const { data: prev } = await db.from("peer_snapshot").select("*").eq("tracker_id", tid).maybeSingle();
  if (!body.force && prev?.fetched_at && now.getTime() - new Date(prev.fetched_at).getTime() < FRESH_HOURS * 3600e3) {
    await syncOpponent(db, tid, prev);
    return json({ cached: true, ...prev });
  }

  try {
    const row = await fetchRow(db, tid, now);
    await syncOpponent(db, tid, row);
    return json({ cached: false, ...row });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 502);
  }
});

// One fencer, honouring the cache unless forced; returns a short status word.
// deno-lint-ignore no-explicit-any
async function readOne(db: any, tid: number, force: boolean): Promise<string> {
  const now = new Date();
  const { data: prev } = await db.from("peer_snapshot").select("*").eq("tracker_id", tid).maybeSingle();
  if (!force && prev?.fetched_at && now.getTime() - new Date(prev.fetched_at).getTime() < FRESH_HOURS * 3600e3) {
    await syncOpponent(db, tid, prev);
    return "cached";
  }
  try {
    const row = await fetchRow(db, tid, now);
    await syncOpponent(db, tid, row);
    return "read";
  } catch (err) { return "failed: " + String((err as Error).message || err).slice(0, 60); }
}

// Profile page + strength page -> the snapshot row. Two reads, one pause.
// deno-lint-ignore no-explicit-any
async function fetchRow(db: any, tid: number, now: Date) {
  {
    const ph = await page(`https://fencingtracker.com/p/${tid}/x`);
    const prof = parseProfile(ph, now);
    // The Registrations tab is only served to logged-in FencingTracker users,
    // so his registrations come from the entry lists this app has already
    // read (ft_event_entrants), joined to the season calendar.
    let registrations: unknown[] = [];
    const { data: ents } = await db.from("ft_event_entrants").select("ft_event_id").eq("tracker_id", tid);
    const evIds = (ents || []).map((x) => Number(x.ft_event_id));
    if (evIds.length) {
      const { data: evs } = await db.from("season_events").select("ft_event_id,tournament,start_date,category,event_code").in("ft_event_id", evIds);
      registrations = (evs || []).map((e) => ({ d: e.start_date, tournament: e.tournament, event: e.event_code || e.category })).sort((a, b) => String(a.d).localeCompare(String(b.d)));
    }
    await sleep(DELAY_MS);
    let strength = {};
    try { strength = parseStrength(await page(`https://fencingtracker.com/p/${tid}/x/strength`)); } catch (_) { /* none */ }
    const row = { tracker_id: tid, name: prof.name, club: prof.club, rating: prof.rating, birth_year: prof.birth_year, ...strength, registrations, results: prof.results, fetched_at: now.toISOString() };
    const up = await db.from("peer_snapshot").upsert(row);
    if (up.error) throw new Error(up.error.message);
    return row;
  }
}
