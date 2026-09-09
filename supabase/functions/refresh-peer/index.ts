// refresh-peer — read one fencer's public FencingTracker record: profile
// (club, rating, birth year, last twelve months of results), registrations,
// and current DE / pool strength. On demand, three pages, cached three days.
// Same manners as refresh-event: identified, slow, never across the site.

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

function parseProfile(html: string, today: Date) {
  const name = clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, ""])[1]).replace(/\s*Verified\s*$/i, "");
  const by = html.match(/person-hero__birth-year">(\d{4})</);
  const club = html.match(/person-hero__club-link"[^>]*>([^<]+)</);
  const rh = html.match(/Rating history[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
  const rating = rh ? (rh[1].match(/<td>([A-EU]\d{0,2})<\/td>/) || [])[1] || null : null;
  const re = /<tr data-ranking-search="[^"]*">\s*<td class="ranking-table__numeric" data-ranking-value="(\d{8})">[^<]*<\/td>\s*<td>([^<]*)<\/td>\s*<td class="person-summary__event-cell">\s*<a href="\/event\/\d+\/results" title="([^"]*)">[^<]*<\/a>\s*<\/td>\s*<td class="ranking-table__numeric" data-ranking-value="\d+">\s*(\d+)\s*\/\s*(\d+)\s*<\/td>/g;
  const cut = new Date(today.getTime() - 365 * 864e5).toISOString().slice(0, 10);
  const results: { d: string; tournament: string; event: string; place: number; field: number }[] = [];
  for (const m of html.matchAll(re)) {
    const d = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}`;
    if (d < cut) continue;
    results.push({ d, tournament: clean(m[2]).slice(0, 60), event: clean(m[3]).slice(0, 40), place: Number(m[4]), field: Number(m[5]) });
  }
  return { name, birth_year: by ? Number(by[1]) : null, club: club ? clean(club[1]) : null, rating, results: results.slice(0, 60) };
}

// Registrations page: rows of date, tournament, event.
function parseRegistrations(html: string) {
  const out: { d: string; tournament: string; event: string }[] = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = m[1];
    const iso = row.match(/\b(20\d\d-\d\d-\d\d)\b/);
    const t = row.match(/href="\/tournament\/\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const e = row.match(/href="\/event\/\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!t || !e) continue;
    let d = iso ? iso[1] : null;
    if (!d) {
      const md = clean(row).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/);
      if (md) { const y = new Date().getFullYear(); const dt = new Date(`${md[1]} ${md[2]}, ${y} UTC`); if (!isNaN(dt.getTime())) d = dt.toISOString().slice(0, 10); }
    }
    out.push({ d: d || "", tournament: clean(t[1]).slice(0, 60), event: clean(e[1]).slice(0, 40) });
  }
  return out.slice(0, 40);
}

function parseStrength(html: string) {
  const m = html.match(/F:\s*\{\s*P:\s*\[([\s\S]*?)\],\s*D:\s*\[([\s\S]*?)\]/);
  if (!m) return {};
  const last = (s: string) => { const pts = [...s.matchAll(/"y":\s*(\d+)/g)]; return pts.length ? Number(pts[pts.length - 1][1]) : null; };
  return { strength_de: last(m[2]), strength_pool: last(m[1]) };
}

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const auth = req.headers.get("Authorization") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (auth !== `Bearer ${serviceKey}`) {
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: who } = await anon.auth.getUser();
    if (!who?.user) return json({ error: "sign in first" }, 401);
  }
  const body = await req.json().catch(() => ({}));
  const tid = Number(body.tracker_id);
  if (!tid) return json({ error: "tracker_id required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const now = new Date();
  const { data: prev } = await db.from("peer_snapshot").select("*").eq("tracker_id", tid).maybeSingle();
  if (!body.force && prev?.fetched_at && now.getTime() - new Date(prev.fetched_at).getTime() < FRESH_HOURS * 3600e3) return json({ cached: true, ...prev });

  try {
    const ph = await page(`https://fencingtracker.com/p/${tid}/x`);
    const prof = parseProfile(ph, now);
    await sleep(DELAY_MS);
    let registrations: unknown[] = [];
    try { registrations = parseRegistrations(await page(`https://fencingtracker.com/p/${tid}/x/registrations`)); } catch (_) { /* none */ }
    await sleep(DELAY_MS);
    let strength = {};
    try { strength = parseStrength(await page(`https://fencingtracker.com/p/${tid}/x/strength`)); } catch (_) { /* none */ }
    const row = { tracker_id: tid, name: prof.name, club: prof.club, rating: prof.rating, birth_year: prof.birth_year, ...strength, registrations, results: prof.results, fetched_at: now.toISOString() };
    const up = await db.from("peer_snapshot").upsert(row);
    if (up.error) return json({ error: up.error.message }, 500);
    return json({ cached: false, ...row });
  } catch (err) {
    return json({ error: String((err as Error).message || err) }, 502);
  }
});
