// geocode — turn "Palm Springs, CA" or a home address into a point, once.
//
// Uses OpenStreetMap's Nominatim, which asks for an identifying User-Agent and
// no more than one request a second. Every venue answer is cached in `places`,
// so a city is looked up once for everyone. A home (a house number or a ZIP
// in the query) is never cached: the family's own household row keeps it.

import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "EnGardeInsight/1.0 (+https://aifenceguy.github.io/en-garde-tsui)";

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
  const q = String(body.q || "").trim();
  if (q.length < 3) return json({ error: "q required" }, 400);
  const key = q.toLowerCase().replace(/\s+/g, " ");

  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const isHome = /^\d+\s/.test(key) || /\d{5}/.test(key);
  const { data: hit } = isHome ? { data: null } : await db.from("places").select("*").eq("key", key).maybeSingle();
  if (hit && hit.lat != null) return json({ cached: true, ...hit });

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) return json({ error: `geocoder ${r.status}` }, 502);
  const res = await r.json();
  const first = Array.isArray(res) && res[0];
  const row = { key, display_name: first ? String(first.display_name) : null, lat: first ? Number(first.lat) : null, lng: first ? Number(first.lon) : null, fetched_at: new Date().toISOString() };
  if (!isHome) await db.from("places").upsert(row);
  return json({ cached: false, ...row });
});
