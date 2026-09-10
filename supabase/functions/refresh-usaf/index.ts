// refresh-usaf — read a USA Fencing national ranking, the way the member
// portal's own page reads it: GET /rankings/data with gender, weapon and age
// category, one page of 100 athletes per request. Each row carries the
// athlete's USA Fencing user id, rating, club, the six carried scores and the
// results behind them (event id, tournament, date, placing, score).
//
// The portal's robots.txt disallows crawlers, so this is not scheduled. It
// runs when a parent asks for it (a signed-in parent), or with the cron secret
// if the household later decides, with USA Fencing's blessing, to schedule it.
// Two or three pages per call, identified user agent, a pause between pages.

import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "EnGardeInsight/1.0 (+https://aifenceguy.github.io/en-garde-tsui; on request, cached)";
const DATA_URL = "https://member.usafencing.org/rankings/data";
const DELAY_MS = 500;
const MAX_PAGES = 4;
const CATS: Record<string, string> = { CADET: "cadet", JUNIOR: "junior", SENIOR: "senior", DIV1: "div1", VETERAN: "vet", Y14: "y14", Y12: "y12", Y10: "y10" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// deno-lint-ignore no-explicit-any
function compactResults(row: any) {
  return (row.results || []).map((r: any) => {
    const p = r.pivot || {};
    return {
      result_id: r.id, event_id: p.event_id, event_code: p.event_code, event_date: String(p.event_date || "").slice(0, 10),
      tournament_id: p.tournament_id, tournament: p.tournament_name, tournament_date: String(p.tournament_date || "").slice(0, 10),
      scope: p.tournament_scope, city: p.tournament_city, state: p.tournament_state,
      place: p.result_placement, tied: p.results_tied, score: Number(p.result_score), counted: Number(p.ranking_score), carried: p.carried === true, included: r.included === true,
    };
  });
}

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const auth = req.headers.get("Authorization") || "";
  let allowed = auth === `Bearer ${serviceKey}`;
  if (!allowed) {
    const given = req.headers.get("x-cron-secret") || "";
    if (given) {
      const { data: s } = await db.from("app_secrets").select("value").eq("name", "cron_secret").maybeSingle();
      allowed = Boolean(s?.value) && given === s.value;
    }
  }
  if (!allowed) {
    // A signed-in parent. The check runs as the caller so RLS and is_parent() apply.
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: who } = await anon.auth.getUser();
    if (!who?.user) return json({ error: "sign in first" }, 401);
    const { data: parent } = await anon.rpc("is_parent");
    if (!parent) return json({ error: "parents only" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const ageKey = String(body.age_category || "CADET").toUpperCase();
  const category = CATS[ageKey];
  if (!category) return json({ error: `unknown age_category ${ageKey}` }, 400);
  const gender = String(body.gender || "MENS").toUpperCase();
  const weapon = String(body.weapon || "FOIL").toUpperCase();
  const weaponCode = (gender === "MENS" ? "M" : "W") + weapon[0];
  const pages = Math.max(1, Math.min(MAX_PAGES, Number(body.pages) || 2));
  const today = new Date().toISOString().slice(0, 10);

  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  let total = 0, lastPage = 1, fetched = 0;
  try {
    for (let page = 1; page <= pages && page <= lastPage; page++) {
      const q = new URLSearchParams({ gender, weapon, age_category: ageKey });
      if (page > 1) q.set("page", String(page));
      const r = await fetch(`${DATA_URL}?${q}`, { headers: { "User-Agent": UA, "Accept": "application/json" } });
      if (!r.ok) return json({ error: `USA Fencing answered ${r.status} on page ${page}` }, 502);
      const payload = await r.json();
      total = Number(payload.total || 0); lastPage = Number(payload.last_page || 1); fetched += 1;
      for (const row of payload.data || []) rows.push(row);
      if (page < pages && page < lastPage) await sleep(DELAY_MS);
    }
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 502);
  }
  if (!rows.length) return json({ error: "no rows came back" }, 502);

  // Today's snapshot replaces today's earlier snapshot for this list.
  await db.from("usaf_rankings").delete().eq("category", category).eq("weapon", weaponCode).eq("as_of", today);
  const out = rows.map((row) => ({
    category, weapon: weaponCode, as_of: today, rank: Number(row.rank), ties: Number(row.ties) || null,
    name: `${row.last_name}, ${row.preferred_name}`, points: Number(row.points), yob: row.year_of_birth || null,
    user_id: row.user_id || null, rating: row.weapon_rating || null, club: row.club_name || null, division: row.division_name || null, region: row.region_name || null,
    carried: (row.carried_scores || []).map(Number), results: compactResults(row), ranking_id: String(row.results?.[0]?.pivot?.ranking_id || ""),
  }));
  for (let i = 0; i < out.length; i += 100) {
    const { error } = await db.from("usaf_rankings").upsert(out.slice(i, i + 100), { onConflict: "category,weapon,as_of,name" });
    if (error) return json({ error: error.message }, 500);
  }

  // The household's own fencers, by USA Fencing user id.
  const ids = out.map((r) => r.user_id).filter(Boolean);
  const { data: mine } = await db.from("profiles").select("id,name,usaf_user_id").in("usaf_user_id", ids.length ? ids : [-1]);
  const updated: string[] = [];
  for (const p of mine || []) {
    const row = out.find((r) => r.user_id === p.usaf_user_id);
    if (!row) continue;
    await db.from("fencer_standings").delete().eq("profile_id", p.id).eq("category", category).eq("weapon", weaponCode);
    await db.from("fencer_standings").insert({ profile_id: p.id, category, weapon: weaponCode, as_of: today, rank: row.rank, points: row.points, counted: row.carried, source: `usafencing.org rankings/data ${ageKey} ${gender} ${weapon}, ${total} athletes` });
    updated.push(`${p.name}: ${row.rank} with ${row.points}`);
  }

  // Marks for "about rank N today": the points at the ranks that matter.
  const marks: Record<string, number> = {};
  for (const r of [1, 8, 16, 32, 50, 64, 100, 150, 200, 300]) { const hit = out.find((x) => x.rank === r) || out.find((x) => x.rank >= r); if (hit && hit.rank <= r + 3) marks[String(r)] = hit.points; }
  await db.from("standings_marks").delete().eq("category", category).eq("weapon", weaponCode);
  await db.from("standings_marks").insert({ category, weapon: weaponCode, as_of: today, listed: total, marks, source: `usafencing.org rankings/data ${ageKey} ${gender} ${weapon}` });

  return json({ category, weapon: weaponCode, as_of: today, pages: fetched, rows: out.length, total, updated, marks });
});
