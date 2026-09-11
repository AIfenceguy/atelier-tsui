// refresh-usaf — read USA Fencing's own numbers, the way the member portal's
// pages read them, and keep a copy.
//
//   age_category CADET | JUNIOR | SENIOR   GET /rankings/data, one page of 100
//                                          athletes per request: user id,
//                                          rating, club, six carried scores and
//                                          the results behind them.
//   age_category Y10 | Y12 | Y14           GET /points/national/{MF}/{Y14}, the
//                                          national points page: one HTML page
//                                          with every ranked athlete (member
//                                          number, YOB, club, top-4 points) and
//                                          result grids per event with the
//                                          event id, placing and points.
//   event_id (or event_ids[])              GET /rankings/events/{id}/results,
//                                          the official final placings of one
//                                          event with each entrant's rating.
//
// The portal's robots.txt disallows crawlers, so nothing here is scheduled. It
// runs when a signed-in parent asks, or with the cron secret if the household
// later schedules it with USA Fencing's blessing. Identified user agent, a
// pause between requests, a handful of requests per call at most.

import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "EnGardeInsight/1.0 (+https://aifenceguy.github.io/en-garde-tsui; on request, cached)";
const HOST = "https://member.usafencing.org";
const DATA_URL = `${HOST}/rankings/data`;
const POINTS_URL = `${HOST}/points/national`;
const EVENT_URL = `${HOST}/rankings/events`;
const DELAY_MS = 500;
const MAX_PAGES = 4;
const MAX_EVENTS = 6;
const CATS: Record<string, string> = { CADET: "cadet", JUNIOR: "junior", SENIOR: "senior", DIV1: "div1", VETERAN: "vet", Y14: "y14", Y12: "y12", Y10: "y10" };
const YOUTH = new Set(["Y10", "Y12", "Y14"]);
const CODE_CATEGORY: Record<string, string> = { Y10: "y10", Y12: "y12", Y14: "y14", CDT: "cadet", JNR: "junior", DV1: "div1", SNR: "senior", VET: "vet" };
const MARK_RANKS = [1, 8, 16, 20, 24, 32, 40, 50, 64, 100, 150, 200, 300];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- small text helpers -------------------------------------------------
const decode = (t: string) => t.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const strip = (h: string) => decode(String(h || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const noFlag = (t: string) => t.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "").replace(/\s+/g, " ").trim();
const num = (t: string | null | undefined) => { const v = Number(String(t ?? "").replace(/,/g, "").trim()); return Number.isFinite(v) && String(t ?? "").trim() !== "" && String(t).trim() !== "-" ? v : null; };
const isoDate = (mdy: string) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(mdy || ""); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; };
const tierOf = (title: string) => {
  const t = title.toLowerCase();
  if (/\bsjcc\b/.test(t)) return "sjcc";
  if (/\bsyc\b|super youth/.test(t)) return "syc";
  if (/\bnac\b|junior olympics|summer nationals|championships|july challenge/.test(t)) return "nac";
  if (/\brjcc\b|\brcc\b|\bryc\b|\broc\b/.test(t)) return "rjcc";
  return null;
};

// ---- /rankings/data rows ------------------------------------------------
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

// ---- the youth points page ---------------------------------------------
type GridEvent = { event_id: number; tournament_id: number | null; code: string; title: string; event_date: string | null };
type YouthRow = {
  rank: number; tied: boolean; moved: number | null; points: number | null; name: string; member_id: string | null; yob: number | null;
  division: string | null; club: string | null; carried: number[]; results: Record<string, unknown>[];
};

function parseYouthPage(html: string): { rows: YouthRow[]; events: GridEvent[] } {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  if (!tables.length) return { rows: [], events: [] };

  // Table one: the standings. One <tr id="N-place"> per ranked athlete.
  const rows: YouthRow[] = [];
  const byKey = new Map<string, YouthRow>();
  for (const m of tables[0].matchAll(/<tr\s+id="(\d+)-place"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (tds.length < 9) continue;
    const cells = tds.map(strip);
    const mv = /fa-caret-(up|down)[\s\S]*?(\d+)/i.exec(tds[0]);
    const rankText = cells[1];
    const rank = Number(rankText.replace(/\D/g, ""));
    if (!rank) continue;
    const href = /\/points\/national\/[A-Z]{2}\/Y\d+\/(\d+)/i.exec(tds[4]);
    const row: YouthRow = {
      rank, tied: /^t/i.test(rankText), moved: mv ? (mv[1].toLowerCase() === "up" ? 1 : -1) * Number(mv[2]) : null,
      points: num(cells[3]), name: noFlag(cells[4]), member_id: href ? href[1] : (cells[5].replace(/\D/g, "") || null), yob: num(cells[6]),
      division: cells[7] || null, club: cells[8] || null, carried: cells.slice(9).map(num).filter((v): v is number => v != null), results: [],
    };
    rows.push(row);
    byKey.set(`${row.name.toLowerCase()}|${row.yob}`, row);
  }

  // The result grids: a header cell per event, then a placing and points pair
  // per athlete per event. Athletes are keyed by name and birth year there.
  const events = new Map<number, GridEvent>();
  for (const table of tables.slice(1)) {
    const heads: GridEvent[] = [];
    for (const th of table.matchAll(/<th[^>]*data-event_id="(\d+)"([^>]*)>([\s\S]*?)<\/th>/gi)) {
      const tid = /data-tournament_id="(\d+)"/i.exec(th[2]);
      const small = /<small[^>]*>([\s\S]*?)<\/small>/i.exec(th[3]);
      const title = strip(th[3].replace(/<small[\s\S]*?<\/small>/i, ""));
      const ev: GridEvent = { event_id: Number(th[1]), tournament_id: tid ? Number(tid[1]) : null, code: (title.split(/\s+/)[0] || "").toUpperCase(), title, event_date: isoDate(small ? strip(small[1]) : "") };
      heads.push(ev);
      if (!events.has(ev.event_id)) events.set(ev.event_id, ev);
    }
    if (!heads.length) continue;
    for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const tds = [...tr[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)].map((x) => ({ attrs: x[1], inner: x[2] }));
      if (tds.length < 4) continue;
      const nm = /<span class="ml-1[^"]*">([\s\S]*?)<\/span>/i.exec(tds[1].inner);
      const yb = /<span class="small text-muted">\s*(\d{4})\s*<\/span>/i.exec(tds[1].inner);
      if (!nm) continue;
      const row = byKey.get(`${noFlag(strip(nm[1])).toLowerCase()}|${yb ? Number(yb[1]) : null}`);
      if (!row) continue;
      for (let k = 0; k < heads.length; k++) {
        const place = tds[2 + 2 * k], pts = tds[3 + 2 * k];
        if (!place || !pts) break;
        const rid = /data-result_id="(\d+)"/i.exec(place.attrs);
        if (!rid) continue;
        const ev = heads[k];
        const placeText = strip(place.inner);
        row.results.push({
          result_id: Number(rid[1]), event_id: ev.event_id, tournament_id: ev.tournament_id, event_code: ev.code, tournament: ev.title.replace(/^\S+\s+/, ""),
          event_date: ev.event_date, place: Number(placeText.replace(/\D/g, "")) || null, placing: placeText, score: num(strip(pts.inner)),
          counted: /fw5/.test(pts.attrs) ? num(strip(pts.inner)) : null, carried: /fw5/.test(pts.attrs), tier: tierOf(ev.title),
        });
      }
    }
  }
  return { rows, events: [...events.values()] };
}

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-cron-secret" };
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
  const gender = String(body.gender || "MENS").toUpperCase();
  const weapon = String(body.weapon || "FOIL").toUpperCase();
  const weaponCode = (gender === "MENS" ? "M" : "W") + weapon[0];
  const today = new Date().toISOString().slice(0, 10);
  const headers = { "User-Agent": UA, "Accept": "application/json, text/html" };

  // ---- one event's official results -------------------------------------
  const eventIds: number[] = [...new Set([body.event_id, ...(Array.isArray(body.event_ids) ? body.event_ids : [])].map(Number).filter((n) => n > 0))].slice(0, MAX_EVENTS);
  if (eventIds.length) {
    const done: Record<string, unknown>[] = [];
    // The household's fencers, by the names USA Fencing lists them under.
    const { data: fencers } = await db.from("profiles").select("id,name,usaf_user_id,usaf_member_id").eq("kind", "fencer");
    const listed = new Map<string, string>();
    for (const p of fencers || []) {
      if (p.usaf_user_id) { const { data } = await db.from("usaf_rankings").select("name").eq("user_id", p.usaf_user_id).order("as_of", { ascending: false }).limit(1); if (data?.[0]) listed.set(data[0].name.toLowerCase(), p.name); }
      if (p.usaf_member_id) { const { data } = await db.from("usaf_rankings").select("name").eq("member_id", p.usaf_member_id).order("as_of", { ascending: false }).limit(1); if (data?.[0]) listed.set(data[0].name.toLowerCase(), p.name); }
    }
    for (let i = 0; i < eventIds.length; i++) {
      const id = eventIds[i];
      try {
        const r = await fetch(`${EVENT_URL}/${id}/results`, { headers });
        if (!r.ok) { done.push({ event_id: id, error: `USA Fencing answered ${r.status}` }); continue; }
        const payload = await r.json();
        const ev = payload.event || {};
        const results = Array.isArray(payload.results) ? payload.results : [];
        const { data: known } = await db.from("usaf_events").select("event_id,event_date,title").eq("event_id", id).maybeSingle();
        await db.from("usaf_events").upsert({
          event_id: id, event_code: ev.event_code || null, category: CODE_CATEGORY[String(ev.event_code || "").slice(0, 3).toUpperCase()] || null,
          title: known?.title || [ev.event_code, ev.tournament_name].filter(Boolean).join(" "), tournament: ev.tournament_name || null, city: ev.tournament_location || null,
          event_date: known?.event_date || null, tier: tierOf(String(ev.tournament_name || "")), entrants: results.length, read_at: new Date().toISOString(),
        }, { onConflict: "event_id" });
        await db.from("usaf_event_results").delete().eq("event_id", id);
        const out = results.map((x: any) => ({
          event_id: id, place: Number(String(x.placement || "").replace(/\D/g, "")) || null, placement: x.placement || null,
          last_name: String(x.last_name || "").trim(), first_name: String(x.first_name || "").trim(), rating: x.rating || null, earned_rating: x.earned_rating || null,
          field_type: x.field_type || null, country: x.flag || null,
        })).filter((x: any) => x.last_name || x.first_name);
        for (let k = 0; k < out.length; k += 200) {
          const { error } = await db.from("usaf_event_results").upsert(out.slice(k, k + 200), { onConflict: "event_id,last_name,first_name" });
          if (error) { done.push({ event_id: id, error: error.message }); break; }
        }
        const mine = out.filter((x: any) => listed.has(`${x.last_name}, ${x.first_name}`.toLowerCase())).map((x: any) => `${listed.get(`${x.last_name}, ${x.first_name}`.toLowerCase())}: ${x.placement} of ${out.length}`);
        done.push({ event_id: id, event: ev.event_code, tournament: ev.tournament_name, entrants: out.length, mine });
      } catch (err) { done.push({ event_id: id, error: String((err as Error).message || err) }); }
      if (i < eventIds.length - 1) await sleep(DELAY_MS);
    }
    return json({ events: done });
  }

  const ageKey = String(body.age_category || "CADET").toUpperCase();
  const category = CATS[ageKey];
  if (!category) return json({ error: `unknown age_category ${ageKey}` }, 400);

  // ---- a youth national points page ---------------------------------------
  if (YOUTH.has(ageKey)) {
    let parsed: ReturnType<typeof parseYouthPage>;
    try {
      const r = await fetch(`${POINTS_URL}/${weaponCode}/${ageKey}`, { headers: { "User-Agent": UA, "Accept": "text/html" } });
      if (!r.ok) return json({ error: `USA Fencing answered ${r.status}` }, 502);
      parsed = parseYouthPage(await r.text());
    } catch (err) { return json({ error: String((err as Error).message || err) }, 502); }
    const { rows, events } = parsed;
    if (!rows.length) return json({ error: "no ranked athletes found on the page" }, 502);

    await db.from("usaf_rankings").delete().eq("category", category).eq("weapon", weaponCode).eq("as_of", today);
    const out = rows.map((row) => ({
      category, weapon: weaponCode, as_of: today, rank: row.rank, ties: row.tied ? 1 : null, moved: row.moved, name: row.name, points: row.points, yob: row.yob,
      member_id: row.member_id, division: row.division, club: row.club, carried: row.carried, results: row.results, ranking_id: `points/national/${weaponCode}/${ageKey}`,
    }));
    for (let i = 0; i < out.length; i += 100) {
      const { error } = await db.from("usaf_rankings").upsert(out.slice(i, i + 100), { onConflict: "category,weapon,as_of,name" });
      if (error) return json({ error: error.message }, 500);
    }
    // The events the page knows, with their USA Fencing ids: the key to
    // official results and to the calendar.
    if (events.length) {
      const evRows = events.map((e) => ({
        event_id: e.event_id, tournament_id: e.tournament_id, event_code: `${e.code}${weaponCode}`, category: CODE_CATEGORY[e.code] || null,
        title: e.title, tournament: e.title.replace(/^\S+\s+\d{4}\s+/, ""), event_date: e.event_date, tier: tierOf(e.title),
      }));
      const { error } = await db.from("usaf_events").upsert(evRows, { onConflict: "event_id", ignoreDuplicates: false });
      if (error) return json({ error: error.message }, 500);
    }

    // The household's fencers, by member number. One without a number yet is
    // matched once by first name and birth year, and keeps the number.
    const ids = out.map((r) => r.member_id).filter(Boolean) as string[];
    const { data: mine } = await db.from("profiles").select("id,name,usaf_member_id").in("usaf_member_id", ids.length ? ids : ["-"]);
    const { data: unkeyed } = await db.from("profiles").select("id,name,birth_year").eq("kind", "fencer").is("usaf_member_id", null);
    const found = [...(mine || [])];
    for (const p of unkeyed || []) {
      const first = String(p.name || "").trim().toLowerCase().split(/\s+/)[0];
      const hits = rows.filter((row) => row.yob === Number(p.birth_year) && (row.name.split(",")[1] || "").trim().toLowerCase().split(/\s+/)[0] === first);
      if (hits.length === 1 && hits[0].member_id) {
        await db.from("profiles").update({ usaf_member_id: hits[0].member_id }).eq("id", p.id);
        found.push({ id: p.id, name: p.name, usaf_member_id: hits[0].member_id });
      }
    }
    const updated: string[] = [];
    for (const p of found) {
      const row = out.find((r) => r.member_id === p.usaf_member_id);
      if (!row) continue;
      await db.from("fencer_standings").delete().eq("profile_id", p.id).eq("category", category).eq("weapon", weaponCode);
      await db.from("fencer_standings").insert({ profile_id: p.id, category, weapon: weaponCode, as_of: today, rank: row.rank, points: row.points, counted: row.carried, source: `usafencing.org points/national ${weaponCode} ${ageKey}, ${out.length} athletes` });
      updated.push(`${p.name}: ${row.rank} with ${row.points}`);
    }
    const marks: Record<string, number> = {};
    for (const r of MARK_RANKS) { const hit = out.find((x) => x.rank === r) || out.find((x) => x.rank >= r); if (hit && hit.rank <= r + 3 && hit.points != null) marks[String(r)] = hit.points; }
    await db.from("standings_marks").delete().eq("category", category).eq("weapon", weaponCode);
    await db.from("standings_marks").insert({ category, weapon: weaponCode, as_of: today, listed: out.length, marks, source: `usafencing.org points/national ${weaponCode} ${ageKey}` });
    return json({ category, weapon: weaponCode, as_of: today, rows: out.length, total: out.length, events: events.length, updated, marks });
  }

  // ---- a paged national ranking (Cadet, Junior, Senior) --------------------
  const pages = Math.max(1, Math.min(MAX_PAGES, Number(body.pages) || 2));
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
  // Every event these results mention, with its USA Fencing id.
  const evMap = new Map<number, Record<string, unknown>>();
  for (const r of out) for (const x of r.results as any[]) {
    if (!x.event_id || evMap.has(x.event_id)) continue;
    evMap.set(x.event_id, { event_id: x.event_id, tournament_id: x.tournament_id || null, event_code: x.event_code || null, category: CODE_CATEGORY[String(x.event_code || "").slice(0, 3).toUpperCase()] || null, title: [x.event_code, x.tournament].filter(Boolean).join(" "), tournament: x.tournament || null, event_date: x.event_date || null, city: [x.city, x.state].filter(Boolean).join(", ") || null, tier: tierOf(String(x.tournament || "")) });
  }
  if (evMap.size) await db.from("usaf_events").upsert([...evMap.values()], { onConflict: "event_id" });

  // The household's own fencers, by USA Fencing user id. A fencer without an
  // id yet is matched once by first name and birth year, and keeps the id.
  const ids = out.map((r) => r.user_id).filter(Boolean);
  const { data: mine } = await db.from("profiles").select("id,name,usaf_user_id").in("usaf_user_id", ids.length ? ids : [-1]);
  const { data: unkeyed } = await db.from("profiles").select("id,name,birth_year,usaf_user_id").eq("kind", "fencer").is("usaf_user_id", null);
  const found = [...(mine || [])];
  for (const p of unkeyed || []) {
    const first = String(p.name || "").trim().toLowerCase().split(/\s+/)[0];
    const hits = rows.filter((row) => Number(row.year_of_birth) === Number(p.birth_year) && String(row.preferred_name || "").trim().toLowerCase().split(/\s+/)[0] === first);
    if (hits.length === 1) {
      await db.from("profiles").update({ usaf_user_id: hits[0].user_id }).eq("id", p.id);
      found.push({ id: p.id, name: p.name, usaf_user_id: hits[0].user_id });
    }
  }
  const updated: string[] = [];
  for (const p of found) {
    const row = out.find((r) => r.user_id === p.usaf_user_id);
    if (!row) continue;
    await db.from("fencer_standings").delete().eq("profile_id", p.id).eq("category", category).eq("weapon", weaponCode);
    await db.from("fencer_standings").insert({ profile_id: p.id, category, weapon: weaponCode, as_of: today, rank: row.rank, points: row.points, counted: row.carried, source: `usafencing.org rankings/data ${ageKey} ${gender} ${weapon}, ${total} athletes` });
    updated.push(`${p.name}: ${row.rank} with ${row.points}`);
  }

  // Marks for "about rank N today": the points at the ranks that matter.
  const marks: Record<string, number> = {};
  for (const r of MARK_RANKS) { const hit = out.find((x) => x.rank === r) || out.find((x) => x.rank >= r); if (hit && hit.rank <= r + 3) marks[String(r)] = hit.points; }
  await db.from("standings_marks").delete().eq("category", category).eq("weapon", weaponCode);
  await db.from("standings_marks").insert({ category, weapon: weaponCode, as_of: today, listed: total, marks, source: `usafencing.org rankings/data ${ageKey} ${gender} ${weapon}` });

  return json({ category, weapon: weaponCode, as_of: today, pages: fetched, rows: out.length, total, events: evMap.size, updated, marks });
});
