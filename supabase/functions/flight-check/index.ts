// flight-check — price every active travel watch on Google Flights (through
// SerpAPI), record what was found, and raise an alert when a fare hits the
// target, sets a new low, or drops far enough below what was already paid to
// be worth rebooking. A port of supabase-backups/flight-check.ps1 so it no
// longer needs a PC to be awake at 7am.
//
// Secrets (Supabase project settings -> Edge Functions -> Secrets):
//   SERPAPI_KEY      required to price anything; without it the run is skipped.
//   RESEND_API_KEY   optional; alerts go out through Resend (ALERT_FROM sets the sender).
//   SMTP_USER/PASS   optional; Gmail app password, alerts go out through SMTP.
// Alerts are always written to flight_alerts, sent or not, so the Travel
// screen can show them.
//
// Body: { watch_id?: uuid, full_sweep?: boolean, dry_run?: boolean }
//   cron calls it daily with {}; Sundays widen to every airport; a parent's
//   "Check now" passes the watch id; dry_run prices but never sends.

import { createClient } from "npm:@supabase/supabase-js@2";

const SERP = "https://serpapi.com/search";
const DELAY_MS = 400;
const MAX_SEARCHES_PER_RUN = 48;
const TZ = "America/Los_Angeles";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ptDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const ptWeekday = (d = new Date()) => d.toLocaleDateString("en-US", { weekday: "long", timeZone: TZ });
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86400000);
const money = (n: number) => `$${Math.round(n)}`;

function expandDates(start: string | null, end: string | null, fallback: string | null): (string | null)[] {
  const s = start || fallback, e = end || fallback;
  if (!s) return [null];
  const out: string[] = [];
  for (let d = s; d <= (e || s); d = addDays(d, 1)) { out.push(d); if (out.length > 7) break; }
  return out;
}

// deno-lint-ignore no-explicit-any
type Offer = any;

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
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: who } = await anon.auth.getUser();
    if (!who?.user) return json({ error: "sign in first" }, 401);
    const { data: parent } = await anon.rpc("is_parent");
    if (!parent) return json({ error: "parents only" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const fullSweep = body.full_sweep === true;
  const dryRun = body.dry_run === true;
  const serpKey = Deno.env.get("SERPAPI_KEY") || "";
  if (!serpKey) return json({ skipped: true, reason: "SERPAPI_KEY is not set in the function secrets" });

  let q = db.from("flight_watches").select("*").is("deleted_at", null).eq("is_active", true);
  if (body.watch_id) q = q.eq("id", body.watch_id);
  const { data: watches, error: werr } = await q;
  if (werr) return json({ error: werr.message }, 500);
  if (!watches?.length) return json({ watches: 0, note: "no active watches" });

  const today = ptDate();
  const sundaySweep = fullSweep || ptWeekday() === "Sunday";
  let searches = 0;
  const report: Record<string, unknown>[] = [];

  for (const w of watches) {
    const origins: string[] = (Array.isArray(w.origins) && w.origins.length ? w.origins : (w.origin ? [w.origin] : [])).map((x: string) => String(x).toUpperCase());
    if (!origins.length) { report.push({ watch: w.label, skipped: "no origins" }); continue; }
    if (w.depart_date && w.depart_date < today) {
      await db.from("flight_watches").update({ is_active: false }).eq("id", w.id);
      report.push({ watch: w.label, deactivated: `departure ${w.depart_date} has passed` });
      continue;
    }

    let departDates = expandDates(w.depart_window_start, w.depart_window_end, w.depart_date);
    let returnDates = expandDates(w.return_window_start, w.return_window_end, w.return_date);
    let originsToday: string[];
    let mode: string;
    if (w.booked_at && w.booked_out_origin && !fullSweep) {
      // Booked: the only question left is whether the held leg dropped enough
      // to rebook for a credit, so price that leg alone, in the shape bought.
      originsToday = [String(w.booked_out_origin).toUpperCase()];
      if (w.booked_out_date) departDates = [w.booked_out_date];
      returnDates = (w.booked_ret_cash && w.booked_ret_date) ? [w.booked_ret_date] : [null];
      mode = "booked leg";
    } else {
      originsToday = (sundaySweep || !w.preferred_origin) ? origins : [String(w.preferred_origin).toUpperCase()];
      mode = sundaySweep ? "full sweep" : "daily check";
    }
    const pax = Math.max(1, Number(w.passengers) || 1);
    const baselineDepart = [...departDates].filter(Boolean).sort().pop() as string | null;
    const hotelRate = Number(w.hotel_nightly_rate) || 0;
    const earlyPen = Number(w.early_depart_penalty) || 0;
    const afterTime = w.preferred_depart_after ? String(w.preferred_depart_after).slice(0, 5) : null;
    const penalties = (w.origin_penalties && typeof w.origin_penalties === "object") ? w.origin_penalties : {};

    type Found = { origin: string; price: number; effective: number; airline: string; stops: number; url: string; departDate: string; returnDate: string | null; departAt: string; extraNights: number };
    const found: Found[] = [];
    const errors: string[] = [];

    for (const origin of originsToday) for (const departDate of departDates) for (const returnDate of returnDates) {
      if (!departDate) continue;
      if (searches >= MAX_SEARCHES_PER_RUN) { errors.push("search budget for this run used up"); break; }
      const params = new URLSearchParams({ engine: "google_flights", departure_id: origin, arrival_id: String(w.destination).toUpperCase(), outbound_date: departDate, currency: "USD", hl: "en", adults: String(pax), api_key: serpKey });
      if (returnDate) { params.set("return_date", returnDate); params.set("type", "1"); } else params.set("type", "2");
      if (w.nonstop_only) params.set("stops", "1");
      searches += 1;
      let res: Offer;
      try {
        const r = await fetch(`${SERP}?${params}`);
        res = await r.json();
        if (!r.ok || res?.error) { errors.push(`${origin} ${departDate}: ${res?.error || r.status}`); await sleep(DELAY_MS); continue; }
      } catch (err) { errors.push(`${origin} ${departDate}: ${(err as Error).message}`); await sleep(DELAY_MS); continue; }

      const offers: Offer[] = [...(res.best_flights || []), ...(res.other_flights || [])].filter((o: Offer) => Number(o?.price) > 0);
      if (!offers.length) { errors.push(`${origin} ${departDate}: no offers`); await sleep(DELAY_MS); continue; }
      const best = offers.sort((a: Offer, b: Offer) => Number(a.price) - Number(b.price))[0];
      // Google prices the whole party at this adults count, so this is a party total.
      const price = Number(best.price);
      const segs: Offer[] = best.flights || [];
      const carrier = segs[0]?.airline || "";
      const flightNums = segs.map((s: Offer) => s.flight_number).filter(Boolean).join(",");
      const stops = Math.max(0, segs.length - 1);
      const departAt = segs[0]?.departure_airport?.time || null;
      const arriveAt = segs[segs.length - 1]?.arrival_airport?.time || null;

      // True cost, not sticker price: an earlier departure buys hotel nights,
      // a school-hours departure and a longer drive both cost something real.
      const extraNights = baselineDepart ? Math.max(0, daysBetween(baselineDepart, departDate)) : 0;
      const hotelCost = extraNights * hotelRate;
      let timePenalty = 0;
      if (afterTime && departAt) { const hhmm = String(departAt).slice(11, 16); if (hhmm && hhmm < afterTime) timePenalty = earlyPen; }
      const originPenalty = Number(penalties[origin]) || 0;
      const effective = price + hotelCost + timePenalty + originPenalty;
      const layovers = best.layovers || null;
      const url = "https://www.google.com/travel/flights?q=" + encodeURIComponent(`flights from ${origin} to ${w.destination} on ${w.depart_date}${w.return_date ? ` returning ${w.return_date}` : ""}`);

      const row = {
        watch_id: w.id, origin, price, currency: "USD", airline: carrier, flight_numbers: flightNums, depart_at: departAt, arrive_at: arriveAt,
        duration_minutes: best.total_duration ?? null, layovers, max_layover_minutes: Array.isArray(layovers) && layovers.length ? Math.max(...layovers.map((l: Offer) => Number(l.duration) || 0)) : null,
        stops, booking_url: url, source: "serpapi-google-flights", searched_depart_date: departDate, searched_return_date: returnDate,
        effective_cost: effective, price_per_person: Math.round(price / pax * 100) / 100, effective_per_person: Math.round(effective / pax * 100) / 100,
        effective_breakdown: { fare: price, extra_nights: extraNights, hotel_cost: hotelCost, time_penalty: timePenalty, origin_penalty: originPenalty, effective_cost: effective }, raw: best,
      };
      const { error } = await db.from("flight_prices").insert(row);
      if (error) errors.push(`${origin} ${departDate}: could not save (${error.message})`);
      found.push({ origin, price, effective, airline: carrier, stops, url, departDate, returnDate, departAt: departAt || "", extraNights });
      await sleep(DELAY_MS);
    }

    await db.from("flight_watches").update({ last_checked_at: new Date().toISOString() }).eq("id", w.id);
    if (!found.length) { report.push({ watch: w.label, mode, searches: 0, errors }); continue; }

    // Decide whether this is worth an alert. Recommend on effective cost, test
    // the target on the fare, alert on an event (new low, first crossing, a
    // rebook-worthy drop) rather than a standing condition.
    const cheapestNow = [...found].sort((a, b) => a.effective - b.effective)[0];
    const cheapestFare = [...found].sort((a, b) => a.price - b.price)[0];
    const { data: hist } = await db.from("flight_prices").select("price,observed_at").eq("watch_id", w.id).order("price", { ascending: true }).limit(200);
    const prior = (hist || []).filter((h) => ptDate(new Date(h.observed_at)) < today).map((h) => Number(h.price));
    const priorLow = prior.length ? Math.min(...prior) : null;
    const nowSeat = cheapestFare.price / pax;
    const lowSeat = priorLow != null ? priorLow / pax : null;
    let reason: string | null = null;
    let firstEver = false, crossedNow = false;
    if (w.booked_at) {
      const paidSeat = Number(w.booked_out_cash) || 0;
      const thresh = Number(w.rebook_threshold) || 50;
      const drop = paidSeat - nowSeat;
      if (paidSeat > 0 && drop >= thresh) reason = `${money(drop)}/seat below the ${money(paidSeat)} you paid, worth rebooking for the credit`;
    } else {
      const newLow = lowSeat != null && nowSeat < lowSeat;
      firstEver = lowSeat == null;
      crossedNow = Boolean(w.target_price) && nowSeat <= Number(w.target_price) && !w.last_alerted_at;
      if (newLow) reason = `a new low, was ${money(lowSeat as number)}/seat`;
      else if (crossedNow) reason = `at or below your ${money(Number(w.target_price))}/seat target`;
    }
    const alertedRecently = w.last_alerted_at ? (Date.now() - new Date(w.last_alerted_at).getTime()) < 20 * 3600 * 1000 : false;
    const summary: Record<string, unknown> = { watch: w.label, mode, searches: found.length, best_per_seat: Math.round(cheapestNow.effective / pax), best_origin: cheapestNow.origin, cheapest_fare_per_seat: Math.round(nowSeat), errors };
    if (!reason) { summary.alert = w.booked_at ? "booked, not enough of a drop" : `no alert, prior low ${lowSeat != null ? money(lowSeat) : "none yet"}`; report.push(summary); continue; }
    if (alertedRecently) { summary.alert = `would alert (${reason}) but already sent in the last 20h`; report.push(summary); continue; }
    if (!w.booked_at && firstEver && !crossedNow) { summary.alert = "first reading recorded; nothing to compare yet"; report.push(summary); continue; }

    const lines: string[] = [];
    const partyNote = pax > 1 ? ` (${money(cheapestNow.price)} for ${pax})` : "";
    lines.push(`${cheapestNow.origin} ${cheapestNow.departDate} -> ${w.destination} is ${money(cheapestNow.price / pax)}/seat${partyNote}, ${reason}.`);
    if (cheapestNow.extraNights > 0) lines.push(`Leaves ${cheapestNow.extraNights} day(s) early: ${money(cheapestNow.effective / pax)}/seat all-in with the extra hotel night, still the best option.`);
    if (cheapestFare.origin !== cheapestNow.origin || cheapestFare.departDate !== cheapestNow.departDate) lines.push(`Cheapest fare was ${cheapestFare.origin} ${cheapestFare.departDate} at ${money(cheapestFare.price / pax)}/seat, but costs more all-in.`);
    lines.push(`${cheapestNow.departDate}${cheapestNow.returnDate ? ` to ${cheapestNow.returnDate}` : ""}: ${cheapestNow.airline}, ${cheapestNow.stops === 0 ? "nonstop" : `${cheapestNow.stops} stop(s)`}`);
    if (found.length > 1) {
      const byOrigin = new Map<string, Found>();
      for (const f of found) { const b = byOrigin.get(f.origin); if (!b || f.effective < b.effective) byOrigin.set(f.origin, f); }
      lines.push("By airport (per seat): " + [...byOrigin.values()].sort((a, b) => a.effective - b.effective).map((f) => `${f.origin} ${money(f.price / pax)}`).join("  "));
    }
    lines.push(cheapestNow.url);
    const message = lines.join("\n");
    const recipients: string[] = [];
    if (w.alert_phone && w.carrier_gateway) recipients.push(`${String(w.alert_phone).replace(/\D/g, "")}@${w.carrier_gateway}`);
    if (w.alert_email) recipients.push(w.alert_email);
    const subject = `Flight ${w.destination} ${money(cheapestNow.price / pax)}/seat`;

    let sentVia: string | null = null, sendError: string | null = null;
    if (!dryRun && recipients.length) {
      const resendKey = Deno.env.get("RESEND_API_KEY") || "";
      const smtpUser = Deno.env.get("SMTP_USER") || "", smtpPass = Deno.env.get("SMTP_PASS") || "";
      if (resendKey) {
        try {
          const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: Deno.env.get("ALERT_FROM") || "En Garde <onboarding@resend.dev>", to: recipients, subject, text: message }) });
          if (r.ok) sentVia = "resend"; else sendError = `resend ${r.status}: ${(await r.text()).slice(0, 200)}`;
        } catch (err) { sendError = `resend: ${(err as Error).message}`; }
      } else if (smtpUser && smtpPass) {
        try {
          const nodemailer = await import("npm:nodemailer@6");
          const transport = nodemailer.default.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass } });
          await transport.sendMail({ from: smtpUser, to: recipients.join(","), subject, text: message });
          sentVia = "gmail-smtp";
        } catch (err) { sendError = `smtp: ${(err as Error).message}`; }
      } else sendError = "no RESEND_API_KEY or SMTP_USER/SMTP_PASS set; alert stored only";
    } else if (!recipients.length) sendError = "no phone or email on this watch; alert stored only";
    await db.from("flight_alerts").insert({ watch_id: w.id, reason, message, recipients, subject, sent_via: sentVia, error: sendError, dry_run: dryRun });
    if (sentVia) await db.from("flight_watches").update({ last_alerted_at: new Date().toISOString() }).eq("id", w.id);
    summary.alert = sentVia ? `sent via ${sentVia} (${reason})` : `stored (${reason}) ${sendError ? "· " + sendError : ""}`;
    report.push(summary);
  }

  return json({ date: today, sweep: sundaySweep, searches, watches: report });
});
