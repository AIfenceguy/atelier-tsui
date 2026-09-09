// refresh-local — the daily read of askFRED's public tournament export for
// youth foil within 60 miles of each household's ZIP. These are the local
// club events a young fencer uses for experience; they are listed, never
// scored for points. One request per household per day.

import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "EnGardeInsight/1.0 (+https://aifenceguy.github.io/en-garde-tsui; daily, cached)";
const RADIUS_MI = 60;

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}
const clean = (s: string) => s.replace(/&#39;|&apos;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

Deno.serve(async (req: Request) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  // Only the cron job (shared secret from app_secrets) or the service key.
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${serviceKey}`) {
    const given = req.headers.get("x-cron-secret") || "";
    const { data: s } = await db.from("app_secrets").select("value").eq("name", "cron_secret").maybeSingle();
    if (!given || !s?.value || given !== s.value) return new Response(JSON.stringify({ error: "not allowed" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  const { data: homes } = await db.from("household").select("owner_user_id,home_zip,home_address");
  const zips = [...new Set((homes || []).map((h) => h.home_zip || (String(h.home_address || "").match(/\b\d{5}\b/) || [])[0]).filter(Boolean))];
  const today = new Date().toISOString().slice(0, 10);
  const out: Record<string, number> = {};
  for (const zip of zips) {
    try {
      const url = `https://www.askfred.net/tournaments.csv?action=index&controller=tournaments&weapon=foil&age=youth&location=${encodeURIComponent(zip)}&radius=${RADIUS_MI}`;
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/csv" } });
      if (!r.ok) { out[zip] = -r.status; continue; }
      const rows = parseCsv(await r.text());
      const head = rows[0].map((h) => h.toLowerCase());
      const ix = (n: string) => head.findIndex((h) => h.includes(n));
      const iT = ix("tournament"), iE = ix("event"), iA = ix("age"), iG = ix("gender"), iR = ix("rating"), iC = ix("close"), iL = ix("location"), iD = ix("distance");
      const byT = new Map<string, { tournament: string; location: string; distance_mi: number; events: unknown[]; first: string }>();
      for (const row of rows.slice(1)) {
        const ev = clean(row[iE] || "");
        if (!/foil/i.test(ev)) continue;
        const gender = String(row[iG] || "").toLowerCase();
        if (gender === "women") continue;   // boys' events: men or mixed
        const close = String(row[iC] || "").slice(0, 10);
        const t = clean(row[iT] || "");
        const key = t + "|" + close.slice(0, 7);
        const cur = byT.get(key) || { tournament: t, location: clean(row[iL] || ""), distance_mi: Number(row[iD] || 0), events: [], first: close };
        cur.events.push({ event: ev, age: row[iA], gender, rating_limit: row[iR], close });
        if (close && close < cur.first) cur.first = close;
        byT.set(key, cur);
      }
      const payload = [...byT.values()].filter((t) => t.first && t.first >= today).map((t) => ({
        zip, tournament: t.tournament, first_date: t.first, location: t.location, distance_mi: t.distance_mi, events: t.events, fetched_at: new Date().toISOString(),
      }));
      await db.from("local_events").delete().eq("zip", zip);
      if (payload.length) await db.from("local_events").upsert(payload);
      out[zip] = payload.length;
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) { out[zip] = -1; }
  }
  return new Response(JSON.stringify({ zips: out }), { headers: { "Content-Type": "application/json" } });
});
