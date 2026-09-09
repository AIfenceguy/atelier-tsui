// Season plan — which events are worth the money, for each boy, and why.
//
// A parent does not want a ranked list of sixty weekends. They want to know
// which weekends fill the season's points slots, which are cheap points,
// which build confidence, which are for development, which only make sense
// because the family is already there, and which to skip. So every event is
// sorted into one of those intentions, per fencer, per category, and each
// category the boy is chasing gets a points plan: the counting rule, the
// slots, the event that fills each slot, the projected total.
//
// Two sources feed the fields. The season table carries the 8 September
// snapshot for every event on the calendar. An event a member adds here is
// refreshed on demand through the refresh-event function - the entry list and
// each entrant's placings and strength trend, read once and cached - and is
// then scored live in the browser (lib/season-model.js), opponents tilted by
// their own 90-day form the same way the boys are seeded on theirs.

import { el, toast } from '../lib/util.js';
import { supa } from '../lib/supa.js';
import { activeProfile } from '../lib/state.js';
import { safeWrite } from '../lib/offline.js';
import { forecast, tierOf, categoryOf } from '../lib/season-model.js';
import { estimateTrip, withLiveFare, milesBetween } from '../lib/trip-cost.js';
import { canSeeSeason, canSeeCosts, isParent } from '../lib/visibility.js';
import { go } from '../lib/router.js';
import { stageOf } from '../lib/lost-bouts.js';

const INK = 'var(--ink)';
// Literal: var(--ink-mute) composites below AA on the cream surface.
const INK_MUTE = '#6B7280';
const GOOD = '#1f7a1f';
const WARN = '#B45309';
const BAD = '#9b2230';

const CAT_ORDER = ['y12', 'y14', 'cadet', 'junior', 'div1'];
const CAT_LABEL = { y12: 'Y12', y14: 'Y14', cadet: 'Cadet', junior: 'Junior', div1: 'Division I' };
const TIER_LABEL = { ryc: 'RYC', syc: 'SYC', rjcc: 'RJCC', regional: 'Regional', sjcc: 'SJCC', nac: 'NAC', jo: 'Junior Olympics', nationals: 'Summer Nationals', other: 'Regional' };
const catLabel = (c) => CAT_LABEL[String(c || '').toLowerCase()] || String(c || '').toUpperCase();
const tierLabel = (t) => TIER_LABEL[String(t || '').toLowerCase()] || String(t || '').toUpperCase();
const NATIONAL = new Set(['nac', 'jo', 'nationals', 'sjcc']);

// Open question for 2026-27: the youth rule counts "national Cadet events"
// toward Y14. Regional Cadet events (RJCC, RCC) now pay national points for
// the Cadet standings, but on 8 Sep 2026 no Y14 row on the member portal
// carried a regional Cadet value, including Raedyn's after Fortune. Until a
// posted standing shows one, the plan counts only Cadet NAC / JO / SJCC /
// Nationals results toward Y14. Flip this when the portal proves otherwise.
const REGIONAL_CADET_COUNTS_FOR_Y14 = false;
// The youth rule: "any national Cadet, Junior, Div I events" count for Y14.
const OLDER = new Set(['cadet', 'junior', 'div1']);
const countsForY14 = (e) => OLDER.has(e.category) && (NATIONAL.has(e.tier) || REGIONAL_CADET_COUNTS_FOR_Y14);

// The intentions, in the order a parent reads them.
const GROUPS = [
    ['registered', 'Going', 'Confirmed trips. Odds and the registered field as it stands today; cost per person.'],
    ['considering', 'Considering', 'On the shortlist. Same odds, same field, priced per person, waiting on a yes.'],
    ['anchor', 'Season anchors · national points', 'NACs, Junior Olympics and Nationals. The family goes; these fill the national slots.'],
    ['value', 'Best value for points', 'Real points for the money. Sorted by points per hundred dollars.'],
    ['confidence', 'Confidence builders · no national points', 'Regional youth events he would seed to win. Nothing counts nationally; what counts is winning on a Sunday.'],
    ['challenge', 'Challenging · development', 'Fields where he is mid-pack: the bouts that teach, with little on the scoreboard.'],
    ['addon', 'Only if already there', 'His brother is going. His cost is a fare and an entry, and the pressure is low.'],
    ['skip', 'Not worth going', 'Expensive for what comes back, or the wrong category for him right now.']
];

const label = (text, color = INK_MUTE, extra = {}) =>
    el('div', { class: 'label', style: { color, ...extra } }, [text]);
const serif = (text, size = '26px', color = INK) => el('div', {
    style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: size, lineHeight: '1.15', color }
}, [text]);
const num = (text, color = INK, size = '20px') =>
    el('span', { class: 'num', style: { color, fontSize: size, fontWeight: '600' } }, [text]);
const money = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString();
// Set per mount from the parent's Settings: show money, allow changes.
let COSTS = true;
let PARENT = true;
const day = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00');
const fmtDay = (iso) => day(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtRange = (a, b) => (!b || b === a) ? fmtDay(a)
    : fmtDay(a) + ' – ' + day(b).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const pct = (x) => x == null ? '—' : Math.round(x * 100) + '%';
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function stat(lbl, value, color = INK) {
    return el('div', { style: { minWidth: '76px' } }, [label(lbl), el('div', {}, [num(String(value ?? '—'), color, '18px')])]);
}

// Set once per mount: the family's home, the geocoded venue cities, and the
// airports they can realistically fly from.
let HOME = null;
let PLACES = new Map();
let AIRPORTS = [];

// USA Fencing age categories for the 2026-27 season, by birth year. The
// youngest category he is eligible for is his own; anything older is playing up.
function primaryCategory(birthYear) {
    if (!birthYear) return null;
    if (birthYear >= 2014) return 'y12';
    if (birthYear >= 2012) return 'y14';
    if (birthYear >= 2010) return 'cadet';
    return 'junior';
}
const catRank = (c) => CAT_ORDER.indexOf(c);

// The strength to seed him on: his 90-day performance when there are enough
// bouts to trust it, else 180 days, else the official number.
function formStrength(ts, profile) {
    const t90 = ts[90], t180 = ts[180];
    if (t90?.bouts >= 20 && t90.performance_rating) return t90.performance_rating;
    if (t180?.bouts >= 20 && t180.performance_rating) return t180.performance_rating;
    return profile.strength_de ?? 1500;
}

export async function mountSeason(root) {
    const profile = activeProfile();
    if (!profile) {
        root.appendChild(el('div', { class: 'empty' }, [el('p', { class: 'empty-line' }, ['Pick a fencer to see the season plan.'])]));
        return;
    }
    root.appendChild(el('div', { style: { padding: '40px var(--gut) 8px' } }, [
        el('h1', { class: 'page-eyebrow' }, ['Season Plan']),
        el('div', { class: 'today-sub' }, [el('span', {}, [profile.name.toUpperCase()])])
    ]));
    // A kid's login sees the plan only if the parent switched it on in
    // Settings, and sees costs only if the parent allows that too. The
    // database enforces both; this just keeps the screen honest.
    if (!canSeeSeason()) {
        root.appendChild(el('div', { class: 'empty' }, [el('p', { class: 'empty-line' }, ['Competition planning is on the parent\'s account.'])]));
        return;
    }
    COSTS = canSeeCosts();
    PARENT = isParent();
    const body = el('div', {});
    root.appendChild(body);
    body.appendChild(el('div', { class: 'empty' }, [el('p', { class: 'empty-line' }, ['Reading the fields…'])]));

    const today = new Date().toISOString().slice(0, 10);
    const since180 = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
    const [tsRes, evRes, watchRes, priceRes, boutRes, refreshRes, mineRes, homeRes, runRes, sibRes, marksRes, goalsRes, standRes, airRes, allBoutsRes, journalRes] = await Promise.all([
        supa.from('true_strength').select('*').eq('profile_id', profile.id),
        supa.from('season_events').select('*').gte('start_date', today).order('start_date'),
        supa.from('flight_watches').select('id,label,destination,depart_date,return_date,hotel_nightly_rate,booked_out_cash,booked_ret_cash,passengers').is('deleted_at', null),
        supa.from('flight_prices').select('watch_id,price_per_person,effective_per_person,observed_at').order('observed_at', { ascending: false }).limit(200),
        supa.from('fencer_bouts').select('*').eq('profile_id', profile.id).order('bout_date', { ascending: false }).limit(40),
        supa.from('event_refresh').select('*'),
        supa.from('member_events').select('*').eq('profile_id', profile.id),
        supa.from('household').select('*').maybeSingle(),
        supa.from('refresh_runs').select('finished_at,events_done,pages').not('finished_at', 'is', null).order('id', { ascending: false }).limit(1).maybeSingle(),
        supa.from('profiles').select('id,name,birth_year,strength_de,strength_pool,tracker_id').eq('kind', 'fencer'),
        supa.from('standings_marks').select('*').eq('weapon', 'MF'),
        supa.from('fencer_goals').select('*'),
        supa.from('fencer_standings').select('*').eq('profile_id', profile.id),
        supa.from('airports').select('*'),
        // Behind the strength card: every rated bout in the six-month window,
        // and the journal entries that already tell the story of some of them.
        supa.from('fencer_bouts').select('*').eq('profile_id', profile.id).gte('bout_date', since180).order('bout_date', { ascending: false }).order('bout_no'),
        supa.from('bouts').select('id,date,my_score,their_score,opponent_tracker_id,source_bout_id,reflection').eq('profile_id', profile.id).is('deleted_at', null).gte('date', since180)
    ]);
    body.innerHTML = '';
    if (runRes?.data?.finished_at) {
        body.appendChild(el('div', { class: 'label', style: { color: INK_MUTE, padding: '0 var(--gut) 12px' } }, [
            `Fields last read ${new Date(runRes.data.finished_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · refreshed nightly`
        ]));
    }

    HOME = homeRes.data?.home_lat != null ? { lat: homeRes.data.home_lat, lng: homeRes.data.home_lng, city: homeRes.data.home_city, hotel_night: homeRes.data.hotel_night } : null;
    // Airports within about 75 minutes of home: 75 road miles is the working radius.
    AIRPORTS = HOME ? (airRes?.data || []).map((a) => ({ ...a, miles: Math.round(milesBetween(HOME, a) || 9999) })).filter((a) => a.miles <= 75).sort((a, b) => a.miles - b.miles) : [];
    PLACES = new Map();
    if (HOME) {
        const keys = [...new Set((evRes.data || []).map((e) => String(e.city || '').toLowerCase().replace(/\s+/g, ' ').trim()).filter((k) => k && k !== 'tba'))];
        for (let i = 0; i < keys.length; i += 100) {
            const { data } = await supa.from('places').select('key,lat,lng').in('key', keys.slice(i, i + 100));
            for (const p of data || []) if (p.lat != null) PLACES.set(p.key, { lat: p.lat, lng: p.lng });
        }
    }

    const ts = Object.fromEntries((tsRes.data || []).map((r) => [r.days, r]));
    const myForm = formStrength(ts, profile);
    const refreshed = new Map((refreshRes.data || []).map((r) => [Number(r.ft_event_id), r]));
    const mine = mineRes.data || [];
    const watches = watchRes.data || [];
    const latestPrice = {};
    for (const p of priceRes.data || []) if (!latestPrice[p.watch_id]) latestPrice[p.watch_id] = p;
    const siblings = (sibRes.data || []).filter((s) => s.id !== profile.id);
    // What he is chasing, from fencer_goals; a sensible default when unset.
    const allGoals = new Map((goalsRes?.data || []).map((g) => [g.profile_id, g]));
    const goals = allGoals.get(profile.id) || { focus_category: primaryCategory(profile.birth_year), secondary: [], ride_along: [], travels_with: null, pressure: 'ranking' };
    const sibling = (goals.travels_with && siblings.find((s) => s.id === goals.travels_with)) || siblings[0] || null;
    const siblingGoals = sibling ? (allGoals.get(sibling.id) || { focus_category: primaryCategory(sibling.birth_year), secondary: [], ride_along: [] }) : null;

    // Events: the season table, plus anything this member added that is not on it.
    let events = (evRes.data || []).filter((e) => e.projections && e.projections[profile.name]);
    const known = new Set(events.map((e) => Number(e.ft_event_id)).filter(Boolean));
    for (const m of mine) {
        if (known.has(Number(m.ft_event_id))) continue;
        const r = refreshed.get(Number(m.ft_event_id));
        const cat = m.category || categoryOf(r?.title);
        events.push({
            id: 'member-' + m.id, ft_event_id: m.ft_event_id, tournament: m.tournament || r?.title || `FencingTracker event ${m.ft_event_id}`,
            category: cat, tier: tierOf(m.tournament || r?.title, cat), start_date: m.event_date || r?.event_date || today, end_date: m.event_date || r?.event_date || today,
            city: null, venue: null, travel: null, entrants: r?.entrants, est_cost_two: null, cost_breakdown: null,
            projections: { [profile.name]: { points_exp: null, seed_form: null, p8: null, p16: null, exp: null, pending: true } }, member_added: true
        });
    }
    await applyLiveForecasts(events, refreshed, profile, myForm);
    events = events.filter((e) => e.projections[profile.name]).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

    // Cost per trip (this fencer's own days at that tournament), then intentions.
    const marks = Object.fromEntries((marksRes?.data || []).map((m) => [m.category, m]));
    const standing = Object.fromEntries((standRes?.data || []).map((s) => [s.category, s]));
    // What the family has decided: going, or on the shortlist. Matched by our
    // own row id first (national events have no FencingTracker id yet), then by
    // FencingTracker id.
    const statusOf = new Map();
    for (const m of mine) {
        if (m.season_event_id) statusOf.set('s:' + m.season_event_id, m.status || 'going');
        if (m.ft_event_id) statusOf.set('f:' + Number(m.ft_event_id), m.status || 'going');
    }
    const decision = (e) => statusOf.get('s:' + e.id) || statusOf.get('f:' + Number(e.ft_event_id)) || null;
    const registered = new Set(events.filter((e) => decision(e) === 'going').map((e) => Number(e.ft_event_id)).filter(Boolean));
    const ctx = { profile, sibling, siblingGoals, goals, ts90: ts[90], primary: goals.focus_category || primaryCategory(profile.birth_year), watches, latestPrice, events, sycKeep: new Set(), marks, standing, registered, decision };
    for (const e of events) e.cost = tripCost(e, ctx);
    // One SYC counts per youth category: keep the best and one backup as
    // value; the rest are insurance at best. The family's rule narrows the
    // SYCs considered to the ones they will actually travel to.
    for (const cat of ['y12', 'y14']) {
        const ranked = events.filter((e) => e.category === cat && e.tier === 'syc' && sycAllowed(e, ctx) && (e.projections[profile.name]?.points_exp || 0) >= 20)
            .map((e) => ({ e, pts: e.projections[profile.name].points_exp, ppd: e.cost?.total > 0 ? e.projections[profile.name].points_exp / e.cost.total * 100 : 0 }))
            .filter((x) => x.ppd >= 3 || siblingGoing(x.e, ctx))
            .sort((a, b) => b.ppd - a.ppd);
        ranked.slice(0, 2).forEach((x) => ctx.sycKeep.add(x.e.id));
    }
    // The focus category is classified first, so secondary categories can see
    // which weekends he is already at.
    const focusFirst = events.slice().sort((a, b) => (a.category === ctx.primary ? 0 : 1) - (b.category === ctx.primary ? 0 : 1));
    for (const e of focusFirst) e.group = classify(e, ctx);

    body.appendChild(strengthCard(profile, ts, myForm, { bouts: allBoutsRes.data || [], journal: journalRes.data || [] }));
    body.appendChild(goalsCard(profile, goals, sibling));
    body.appendChild(primerCard(goals));
    const planCats = [ctx.primary, ...(goals.secondary || [])].filter((c, i, a) => c && a.indexOf(c) === i && events.some((e) => e.category === c));
    for (const cat of planCats) body.appendChild(pointsPlanCard(profile, cat, events.filter((e) => e.category === cat), ctx));
    if (COSTS) {
        body.appendChild(rankedCalendar(events, ctx, true));
        body.appendChild(rankedCalendar(events, ctx, false));
    }
    body.appendChild(await localEventsCard(profile, homeRes.data));
    for (const [key, title, sub] of GROUPS) {
        const rows = events.filter((e) => e.group === key);
        if (!rows.length) continue;
        if (key === 'registered' || key === 'considering') { body.appendChild(weekendsCard(key, title, sub, rows, ctx, refreshed)); continue; }
        let t = title, s = sub;
        if (key === 'addon' && sibling) {
            t = goals.pressure === 'development' ? `Along for the ride · with ${sibling.name}` : 'Only if already there';
            s = goals.pressure === 'development'
                ? `${sibling.name} is going anyway. ${profile.name} fences these with no points pressure; the cost is his fare and an entry.`
                : `${sibling.name} is going, or ${profile.name} is there for his own category. The cost is an entry, or a fare and an entry.`;
        }
        body.appendChild(groupCard(key, t, s, rows, ctx, refreshed));
    }
    body.appendChild(await peersCard(profile, events));
    body.appendChild(howToRead(profile, sibling));
    if (PARENT) body.appendChild(addEventCard(profile));
    body.appendChild(recentBouts(boutRes.data || [], profile));
}

// ---------------------------------------------------------------------------
// What an event actually adds to his season total, under the counting rules.
// Points on the day are not the point: a fourth SYC adds nothing, a seventh
// Cadet result adds nothing, and a parent needs to see that in one number.
// ---------------------------------------------------------------------------
function projectTotal(cat, candidates, name) {
    const P = (e) => e.projections[name]?.points_exp || 0;
    if (cat === 'y12' || cat === 'y14') {
        const syc = candidates.filter((e) => e.tier === 'syc').sort((a, b) => P(b) - P(a));
        const nat = candidates.filter((e) => NATIONAL.has(e.tier)).sort((a, b) => P(b) - P(a));
        const picks = [];
        if (syc[0]) picks.push(P(syc[0]));
        for (const e of nat.slice(0, syc[0] ? 3 : 4)) picks.push(P(e));
        return picks.reduce((a, b) => a + b, 0);
    }
    if (cat === 'cadet') return candidates.map(P).sort((a, b) => b - a).slice(0, 6).reduce((a, b) => a + b, 0);
    return 0;
}

function marginalPoints(e, ctx) {
    const name = ctx.profile.name;
    const cat = e.category;
    if (!['y12', 'y14', 'cadet'].includes(cat)) return null;
    // The pool he is counting on: the events not marked skip in this category,
    // plus, for Y14, cadet national results.
    const base = ctx.events.filter((x) => x !== e && x.group !== 'skip' && (x.category === cat || (cat === 'y14' && countsForY14(x))));
    const without = projectTotal(cat, base, name);
    const withE = projectTotal(cat, [...base, e], name);
    return Math.max(0, withE - without);
}

// The sentence a parent reads first.
function verdict(e, ctx) {
    const p = e.projections[ctx.profile.name] || {};
    const pts = p.points_exp || 0;
    const add = marginalPoints(e, ctx);
    const cost = e.cost?.total || 0;
    const travel = e.travel === 'fly' ? 'a flight' : e.travel === 'drive' ? 'a drive' : e.travel === 'local' ? 'a day trip' : 'travel';
    const g = e.group;
    if (p.pending) return { word: 'Reading', tone: INK_MUTE, why: 'The field has not been read yet.' };
    if (g === 'registered') return { word: 'Going', tone: GOOD, why: `On today's field he would start ${ordinal(p.seed_form)} of ${p.field_n}, likely ${ordinal(Math.round(p.median || p.exp))}, about ${Math.round(pts)} points${add != null ? `, ${Math.round(add)} of them new to his total` : ''}.` };
    if (g === 'considering') return { word: 'Considering', tone: INK, why: `If you go: he would start ${ordinal(p.seed_form)} of ${p.field_n}, likely ${ordinal(Math.round(p.median || p.exp))}, about ${Math.round(pts)} points${add != null ? `, ${Math.round(add)} of them new to his total` : ''}${COSTS ? `, for ${money(e.cost?.per_person ?? cost)} per person` : ''}.` };
    if (g === 'anchor') return { word: 'Family trip', tone: GOOD, why: `A national event that fills one of his counted slots: about ${Math.round(pts)} points${add != null && add < pts - 1 ? `, of which ${Math.round(add)} actually raise his total` : ''}.` };
    if (g === 'value') return { word: 'Go', tone: GOOD, why: add != null && add > 0 ? `Adds about ${Math.round(add)} points to his ranking total for ${COSTS ? `${money(cost)} and ` : ''}${travel}.` : `About ${Math.round(pts)} points on the day for ${COSTS ? `${money(cost)} and ` : ''}${travel}.` };
    if (g === 'confidence') return { word: 'Go if it suits', tone: INK, why: `No national points here. He would start ${ordinal(p.seed_form)} of ${p.field_n}: a weekend of winning, which is worth something on its own.` };
    if (g === 'challenge') return { word: 'Optional', tone: INK, why: `Development, not points. He would start ${ordinal(p.seed_form)} of ${p.field_n} and learn from the bouts he loses.` };
    if (g === 'addon') return { word: 'Only if already there', tone: INK, why: `${add ? `Adds about ${Math.round(add)} points` : `About ${Math.round(pts)} points on the day`} for an entry${e.travel === 'fly' ? ' and a fare' : ''}, because the family is at this venue anyway.` };
    // skip: say which rule killed it, in the parent's words
    const onLists = e.category === ctx.primary || (ctx.goals?.secondary || []).includes(e.category) || (ctx.goals?.ride_along || []).includes(e.category);
    const isRide = (ctx.goals?.ride_along || []).includes(e.category);
    const playingUp = ctx.primary && catRank(e.category) > catRank(ctx.primary);
    const formDown = ctx.ts90 && ctx.ts90.vs_weaker >= 6 && ctx.ts90.losses_vs_weaker / ctx.ts90.vs_weaker >= 0.3;
    if (!onLists) return { word: 'Skip', tone: BAD, why: `${catLabel(e.category)} is not on his plan this season.` };
    if (isRide) return { word: 'Skip', tone: BAD, why: `${catLabel(e.category)} only rides along, and nobody is at this venue anyway.` };
    if (playingUp && formDown) return { word: 'Skip', tone: BAD, why: `Playing up while he is losing ${ctx.ts90.losses_vs_weaker} of ${ctx.ts90.vs_weaker} bouts to weaker fencers. A bracket of losses, not points.` };
    if (e.tier === 'syc' && !sycAllowed(e, ctx)) return { word: 'Skip', tone: BAD, why: `Family rule: local SYCs only (${(ctx.goals.allowed_syc || []).join(', ')}). ${Math.round(pts)} points on the day, but a flight for a result the local ones can give.` };
    if (e.tier === 'syc' && pts >= 20) return { word: 'Skip', tone: BAD, why: `Only one SYC counts and a better one is on the plan. Adds ${Math.round(add || 0)} to his total, whatever he scores on the day.` };
    if (e.tier === 'ryc') return { word: 'Skip', tone: BAD, why: `Regional youth events pay no national points, and this one is ${travel}${cost && COSTS ? ` for ${money(cost)}` : ''}.` };
    if (pts >= 8 && cost > 0) return { word: 'Skip', tone: BAD, why: `${Math.round(pts)} points for ${COSTS ? `${money(cost)} and ` : ''}${travel}. The drives on the plan pay three times better.` };
    return { word: 'Skip', tone: BAD, why: `Nothing here moves his ranking: he would finish around ${ordinal(Math.round(p.median || p.exp || 0))} of ${p.field_n}.` };
}

// ---------------------------------------------------------------------------
// Intention: which group an event belongs in for this fencer.
// ---------------------------------------------------------------------------
// The family's SYC rule: when allowed_syc is set, only those tournaments (or
// one already entered) are considered for the SYC slot.
function sycAllowed(e, ctx) {
    const allow = ctx.goals?.allowed_syc || [];
    if (ctx.registered?.has(Number(e.ft_event_id))) return true;
    if (!allow.length) return true;
    const t = String(e.tournament || '').toLowerCase();
    return allow.some((a) => t.includes(String(a).toLowerCase()));
}

function classify(e, ctx) {
    const p = e.projections[ctx.profile.name] || {};
    const d = ctx.decision ? ctx.decision(e) : null;
    if (d === 'going') return 'registered';
    if (d === 'considering') return 'considering';
    if (p.pending) return 'anchor';
    if (e.tier === 'syc' && !sycAllowed(e, ctx)) return 'skip';
    const pts = p.points_exp || 0;
    const ppd = e.cost?.total > 0 ? pts / e.cost.total * 100 : null;
    const g = ctx.goals || {};
    const isFocus = e.category === ctx.primary;
    const isSecondary = (g.secondary || []).includes(e.category);
    const isRide = (g.ride_along || []).includes(e.category);
    // A category that is on none of his lists is off the plan, full stop.
    if (!isFocus && !isSecondary && !isRide) return 'skip';
    const playingUp = ctx.primary && catRank(e.category) > catRank(ctx.primary);
    const formDown = ctx.ts90 && ctx.ts90.vs_weaker >= 6 && ctx.ts90.losses_vs_weaker / ctx.ts90.vs_weaker >= 0.3;
    const sibGoing = siblingGoing(e, ctx);
    const selfGoing = selfGoingAnyway(e, ctx);
    const flyIn = e.travel === 'fly';

    // Ride-along categories: at a national event only when the brother is
    // going; at a regional only when someone is at that venue anyway, and not
    // while he is playing up with his form down. An older category that
    // counts for a Y14 focus is never a mere ride-along at a national.
    if (isRide && !(ctx.primary === 'y14' && NATIONAL.has(e.tier) && countsForY14(e))) {
        if (NATIONAL.has(e.tier)) return sibGoing ? 'addon' : 'skip';
        return (sibGoing || selfGoing) && !(playingUp && formDown) ? 'addon' : 'skip';
    }

    if (NATIONAL.has(e.tier)) {
        // A national event anchors the season when it fills a slot in the
        // focus category, or when it is an older-category result that also
        // counts for Y14 (Cadet, Junior, Division I).
        if (isFocus || (ctx.primary === 'y14' && countsForY14(e))) return pts >= 3 ? 'anchor' : 'skip';
        return (sibGoing || selfGoing) ? 'addon' : 'skip';
    }
    if (playingUp && formDown) return (sibGoing || selfGoing) && pts >= 8 ? 'addon' : 'skip';
    // Secondary category at a weekend he is already at for the focus category:
    // points along the way for the price of an entry.
    if (isSecondary && selfGoing && pts >= 8) return 'value';
    // Real points: value when the trip is priced right, an add-on when the
    // brother is going anyway, otherwise not worth the fare. A third SYC in a
    // youth category is insurance, not value: only one counts.
    if (e.tier === 'syc' && (e.category === 'y12' || e.category === 'y14') && pts >= 20 && !ctx.sycKeep.has(e.id)) return sibGoing ? 'addon' : 'skip';
    if (pts >= 20 && (ppd == null || ppd >= 3)) return 'value';
    if (pts >= 20) return sibGoing ? 'addon' : 'skip';
    if (sibGoing && pts >= 8) return 'addon';
    // Nobody flies for a development weekend; these are drives, or ride along.
    if (e.tier === 'ryc' && p.seed_form <= 3 && p.p8 >= 0.8) return flyIn ? (sibGoing ? 'addon' : 'skip') : 'confidence';
    if (flyIn && !sibGoing) return 'skip';
    if (p.field_n >= 8 && p.seed_form > 3 && p.seed_form <= Math.max(8, Math.ceil(p.field_n / 2)) && p.p16 >= 0.2 && !playingUp) return flyIn ? 'addon' : 'challenge';
    if (p.field_n >= 8 && p.seed_form <= Math.ceil(p.field_n / 2) && playingUp && !formDown) return flyIn ? 'addon' : 'challenge';
    return 'skip';
}

// Is the brother going to this tournament anyway? He is when he has a
// national event there in his focus category, or real points in it. A
// participation-level entry in a category he is playing up does not count.
function siblingGoing(e, ctx) {
    if (!ctx.sibling) return false;
    const sibFocus = ctx.siblingGoals?.focus_category || primaryCategory(ctx.sibling.birth_year);
    const sibSecondary = ctx.siblingGoals?.secondary || [];
    return ctx.events.some((x) => x.tournament === e.tournament && String(x.start_date).slice(0, 7) === String(e.start_date).slice(0, 7)
        && ((NATIONAL.has(x.tier) && (x.category === sibFocus || (x.category === 'cadet' && sibFocus === 'y14')))
            || (x.category === sibFocus && (x.projections?.[ctx.sibling.name]?.points_exp || 0) >= 20)
            || (sibSecondary.includes(x.category) && (x.projections?.[ctx.sibling.name]?.points_exp || 0) >= 30 && x.travel !== 'fly')));
}

// Is he at this tournament anyway for his focus category? True once a focus
// event there has been sorted as an anchor or value.
function selfGoingAnyway(e, ctx) {
    return ctx.events.some((x) => x !== e && x.tournament === e.tournament && String(x.start_date).slice(0, 7) === String(e.start_date).slice(0, 7)
        && x.category === ctx.primary && (x.group === 'anchor' || x.group === 'value'));
}

// ---------------------------------------------------------------------------
// Points plan: the counting rule for the category, the slots, and the event
// that fills each one.
// ---------------------------------------------------------------------------
function pointsPlanCard(profile, cat, rows, ctx) {
    const name = profile.name;
    const P = (e) => e.projections[name]?.points_exp || 0;
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    const playingUp = ctx.primary && catRank(cat) > catRank(ctx.primary);
    const formDown = ctx.ts90 && ctx.ts90.vs_weaker >= 6 && ctx.ts90.losses_vs_weaker / ctx.ts90.vs_weaker >= 0.3;
    const isFocus = cat === ctx.primary;
    wrap.appendChild(label(isFocus ? `${catLabel(cat)} · ranking plan` : `${catLabel(cat)} · points along the way`));

    const slots = [];
    if (cat === 'y12' || cat === 'y14') {
        const syc = rows.filter((e) => e.tier === 'syc' && e.group !== 'skip' && sycAllowed(e, ctx)).sort((a, b) => P(b) - P(a));
        const nat = rows.filter((e) => NATIONAL.has(e.tier) && e.group !== 'skip').sort((a, b) => P(b) - P(a));
        const cadetNat = cat === 'y14' ? ctx.events.filter((e) => countsForY14(e) && e.group !== 'skip').sort((a, b) => P(b) - P(a)) : [];
        // Best four results count, at most one of them an SYC: the SYC slot
        // plus the three best national results, whichever category they come from.
        const pool = [
            ...nat.map((e) => ({ name: e.tier === 'nationals' ? 'Summer Nationals' : 'NAC', ev: e })),
            ...cadetNat.map((e) => ({ name: `${catLabel(e.category)} national, counts for Y14`, ev: e }))
        ].sort((a, b) => P(b.ev) - P(a.ev));
        if (syc[0]) slots.push({ name: 'One SYC counts', ev: syc[0], alt: syc[1] });
        for (const s of pool.slice(0, syc[0] ? 3 : 4)) slots.push(s);
        const total = slots.reduce((a, s) => a + P(s.ev), 0);
        wrap.appendChild(serif(`${Math.round(total)} points projected`, '26px', total >= 150 ? GOOD : INK));
        wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '2px 0 10px', lineHeight: '1.5' } }, [
            `Best four results count: one SYC at most, the rest from NACs and Summer Nationals${cat === 'y14' ? ', and national Cadet results count too' : ''}. Regional youth events pay no national points.`
        ]));
    } else if (cat === 'cadet') {
        const all = rows.filter((e) => e.group !== 'skip').sort((a, b) => P(b) - P(a)).slice(0, 6);
        for (const e of all) slots.push({ name: NATIONAL.has(e.tier) ? tierLabel(e.tier) : 'Regional', ev: e });
        const total = all.reduce((a, e) => a + P(e), 0);
        wrap.appendChild(serif(`${Math.round(total)} points projected`, '26px', total >= 150 ? GOOD : INK));
        wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '2px 0 10px', lineHeight: '1.5' } }, [
            'Best six results count, and regional Cadet events (RJCC, RCC) count nationally this season: a top 8 is 36.6, top 16 is 31.2, anywhere in the top 64 is 22.2. ',
            'At a NAC the field splits above 168 entries: the Elite bracket (capped at 112) pays 51.6 for a top 64 and 81 for a top 32; the Challenger bracket pays 31.8 and 39.6. NAC rows below show the Challenger figure with the Elite figure in brackets. ',
            'USA Fencing has published the threshold and the cap but not the order it fills Elite with for Cadet; for the first events it is drawn from last season\'s national results re-scored on the new tables.'
        ]));
    }
    // Where he stands today, from the member portal, before any of this.
    const st = ctx.standing?.[cat];
    if (st && st.rank) {
        wrap.appendChild(el('p', { style: { color: INK, fontSize: '13px', margin: '0 0 6px', lineHeight: '1.5' } }, [
            el('b', {}, [`Today: ${ordinal(st.rank)} with ${Number(st.points).toFixed(1)} points`]),
            st.counted?.length ? ` (${st.counted.map((x) => Number(x).toFixed(1)).join(' + ')}). ` : '. ',
            `Standings as of ${new Date(st.as_of + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}; last season's results roll off as this season's land.`
        ]));
    }
    // Where the plan's total would sit on the real standings today.
    const mk = ctx.marks?.[cat];
    if (mk && slots.length) {
        const total = slots.reduce((a, s) => a + P(s.ev), 0);
        const pts = Object.entries(mk.marks).map(([r, p]) => [Number(r), Number(p)]).sort((a, b) => a[0] - b[0]);
        let where;
        if (total >= pts[0][1]) where = `about rank ${pts[0][0]}`;
        else {
            let found = null;
            for (let i = 0; i < pts.length - 1; i++) {
                const [r1, p1] = pts[i], [r2, p2] = pts[i + 1];
                if (total <= p1 && total > p2) { found = Math.round(r1 + (p1 - total) / (p1 - p2) * (r2 - r1)); break; }
            }
            where = found ? `about rank ${found}` : `outside the top ${pts[pts.length - 1][0]}`;
        }
        const need = (r) => mk.marks[r] != null ? `top ${r} needs ${Math.round(mk.marks[r])}` : null;
        wrap.appendChild(el('p', { style: { color: INK, fontSize: '13px', margin: '0 0 10px', lineHeight: '1.5' } }, [
            el('b', {}, [`On today's ${catLabel(cat)} standings that is ${where}`]),
            ` of ${mk.listed || '—'} ranked. `,
            [need(16), need(20), need(32), need(64)].filter(Boolean).join(', ') + `. Standings as of ${new Date(mk.as_of + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}; they roll, so last season's results drop out as new ones land.`
        ]));
    }
    if (playingUp && formDown) {
        wrap.appendChild(el('p', { style: { color: WARN, fontSize: '13px', margin: '0 0 10px', lineHeight: '1.5', fontWeight: '700' } }, [
            `He is playing up here while losing ${ctx.ts90.losses_vs_weaker} of ${ctx.ts90.vs_weaker} bouts to weaker fencers in his own category. The points below are real, but each one costs a bracket of losses. Fill this category only as an add-on to trips the family is making anyway.`
        ]));
    }
    if (!slots.length) {
        wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: 0 } }, ['Nothing on the calendar fills a slot here yet.']));
        return wrap;
    }
    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) 2fr auto', columnGap: '12px', rowGap: '6px', alignItems: 'baseline' } });
    for (const s of slots) {
        const p = s.ev.projections[name];
        grid.appendChild(label(s.name, INK_MUTE));
        grid.appendChild(el('div', { style: { fontSize: '14px', color: INK } }, [
            el('b', {}, [s.ev.tournament]), el('span', { class: 'label', style: { color: INK_MUTE, marginLeft: '6px' } }, [`${fmtDay(s.ev.start_date)} · seed ${p.seed_form} · ${ordinal(p.median || Math.round(p.exp))}`]),
            s.alt ? el('div', { class: 'label', style: { color: INK_MUTE } }, [`backup: ${s.alt.tournament}, ${Math.round(P(s.alt))} pts`]) : null
        ].filter(Boolean)));
        const elite = s.ev.projections[name]?.points_exp_if_elite;
        grid.appendChild(num(Math.round(P(s.ev)).toString() + (elite ? ` (${Math.round(elite)})` : ''), P(s.ev) >= 30 ? GOOD : INK, '18px'));
    }
    wrap.appendChild(grid);
    return wrap;
}

// ---------------------------------------------------------------------------
// A weekend he is going to (or weighing): every event there he is eligible
// for, what each would pay, and which standings each result feeds. A Junior
// entry is a Junior result and a Y14 result at once; that is the whole point
// of entering everything at a NAC.
// ---------------------------------------------------------------------------
const BIRTH = { y12: [2014, 2017], y14: [2012, 2015], cadet: [2010, 2015], junior: [2007, 2013], div1: [1900, 2013] };
function eligible(cat, profile) {
    const by = profile.birth_year; if (!by) return true;
    const [lo, hi] = BIRTH[cat] || [1900, 2100];
    if (by < lo || by > hi) return false;
    if (cat === 'div1') return /^[ABC]/i.test(String(profile.rating || ''));
    return true;
}
function countsToward(e) {
    const nat = NATIONAL.has(e.tier);
    switch (e.category) {
        case 'y12': return ['Y12'];
        case 'y14': return ['Y14'];
        case 'cadet': return nat ? ['Cadet', 'Y14'] : (REGIONAL_CADET_COUNTS_FOR_Y14 ? ['Cadet', 'Y14'] : ['Cadet']);
        case 'junior': return nat ? ['Junior', 'Y14'] : ['Junior'];
        case 'div1': return nat ? ['Division I', 'Y14'] : ['Division I'];
        default: return [];
    }
}

function weekendsCard(key, title, sub, rows, ctx, refreshed) {
    const name = ctx.profile.name;
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    // Group the decided events by weekend, then pull in every other event at
    // that tournament so the parent sees what else he could enter.
    const weekends = new Map();
    for (const e of rows) {
        const k = e.tournament + '|' + String(e.start_date).slice(0, 7);
        if (!weekends.has(k)) weekends.set(k, { tournament: e.tournament, city: e.city, venue: e.venue, travel: e.travel, start: e.start_date, end: e.end_date, decided: [], all: [] });
        weekends.get(k).decided.push(e);
    }
    for (const w of weekends.values()) {
        w.all = ctx.events.filter((x) => x.tournament === w.tournament && String(x.start_date).slice(0, 7) === String(w.start).slice(0, 7))
            .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)) || catRank(a.category) - catRank(b.category));
        w.start = w.all.reduce((m, x) => x.start_date < m ? x.start_date : m, w.start);
        w.end = w.all.reduce((m, x) => (x.end_date || x.start_date) > (m || '') ? (x.end_date || x.start_date) : m, w.end);
    }
    const list = [...weekends.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)));
    wrap.appendChild(label(`${list.length} weekend${list.length > 1 ? 's' : ''}`));
    wrap.appendChild(serif(title, '24px'));
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '4px 0 6px', lineHeight: '1.5' } }, [sub]));

    for (const w of list) {
        const card = el('div', { style: { padding: '12px 0', borderTop: '1px solid var(--rule)' } });
        const cost = w.decided[0].cost || {};
        card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } }, [
            el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '20px', color: INK } }, [w.tournament]),
            el('span', { class: 'label', style: { color: INK_MUTE } }, [`${fmtRange(w.start, w.end)} · ${w.city || 'city not set'} · ${w.travel === 'fly' ? 'fly' : w.travel === 'drive' ? 'drive' : w.travel === 'local' ? 'day trip' : ''}`])
        ]));
        card.appendChild(el('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', margin: '6px 0 8px' } }, [
            ...(COSTS ? [
                stat('Per person', cost.per_person > 0 ? money(cost.per_person) : '—', cost.live ? GOOD : INK),
                stat('Nights', cost.nights ?? '—'),
                stat(w.travel === 'fly' ? 'Fare, return' : 'Driving', w.travel === 'fly' ? money((cost.flight_pp || 0) * 2) : money(cost.drive || 0))
            ] : [stat('Nights', cost.nights ?? '—')]),
            stat('Points, all his events', w.decided.reduce((a, e) => a + (e.projections[name]?.points_exp || 0), 0).toFixed(0), GOOD)
        ]));

        // The events table: eligible or not, counts toward what, what it pays.
        const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr) 58px 56px 70px 78px', columnGap: '8px', rowGap: '6px', alignItems: 'baseline' } });
        const head = (t, right) => el('span', { class: 'label', style: { color: INK_MUTE, textAlign: right ? 'right' : 'left' } }, [t]);
        ['Event', 'Counts toward', "He'd start", 'Top 8', 'Points', ''].forEach((t, i) => grid.appendChild(head(t, i >= 2 && i <= 4)));
        for (const e of w.all) {
            const p = e.projections[name];
            const ok = eligible(e.category, ctx.profile);
            const st = ctx.decision(e);
            const onPlan = e.category === ctx.primary || (ctx.goals.secondary || []).includes(e.category) || (ctx.goals.ride_along || []).includes(e.category);
            const pts = p?.points_exp;
            const elite = p?.points_exp_if_elite;
            const tone = st === 'going' ? GOOD : !ok ? INK_MUTE : INK;
            grid.appendChild(el('div', { style: { minWidth: 0 } }, [
                el('div', { style: { color: tone, fontSize: '14px', fontWeight: st === 'going' ? '700' : '500' } }, [`${catLabel(e.category)}`, el('span', { class: 'label', style: { color: INK_MUTE, marginLeft: '6px' } }, [fmtDay(e.start_date).replace(/^\w+, /, '')])]),
                el('div', { class: 'label', style: { color: st === 'going' ? GOOD : st === 'considering' ? WARN : INK_MUTE } }, [st === 'going' ? 'Entered' : st === 'considering' ? 'Considering' : !ok ? 'Not eligible' : onPlan ? 'Could add' : 'Eligible, not on his plan'])
            ]));
            grid.appendChild(el('span', { style: { color: ok ? INK : INK_MUTE, fontSize: '13px' } }, [countsToward(e).join(' + ') || '—']));
            grid.appendChild(el('span', { class: 'num', style: { color: INK, fontSize: '13px', textAlign: 'right' } }, [p && ok ? `${p.seed_form}/${p.field_n}` : '—']));
            grid.appendChild(el('span', { class: 'num', style: { color: INK, fontSize: '13px', textAlign: 'right' } }, [p && ok ? pct(p.p8) : '—']));
            grid.appendChild(el('span', { class: 'num', style: { color: pts >= 25 ? GOOD : INK, fontSize: '13px', textAlign: 'right', fontWeight: '600' } }, [p && ok && pts != null ? `${Math.round(pts)}${elite ? ` (${Math.round(elite)})` : ''}` : '—']));
            const cell = el('span', { style: { textAlign: 'right' } });
            if (ok && st !== 'going' && PARENT) {
                const b = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label' }, [st === 'considering' ? 'Going' : 'Add']);
                b.onclick = async () => {
                    b.disabled = true;
                    try {
                        await safeWrite({ table: 'member_events', op: 'upsert', onConflict: 'profile_id,season_event_id', payload: { profile_id: ctx.profile.id, season_event_id: e.id, ft_event_id: e.ft_event_id || null, category: e.category, tournament: e.tournament, event_date: e.start_date, status: 'going' } });
                        location.reload();
                    } catch (err) { b.disabled = false; toast('Could not save: ' + (err.message || err), 'error'); }
                };
                cell.appendChild(b);
            } else if (st === 'going' && PARENT) {
                const b = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label', title: 'Move to considering' }, ['Undo']);
                b.onclick = async () => {
                    b.disabled = true;
                    try {
                        await safeWrite({ table: 'member_events', op: 'update', match: { profile_id: ctx.profile.id, season_event_id: e.id }, payload: { status: 'considering' } });
                        location.reload();
                    } catch (err) { b.disabled = false; toast('Could not save: ' + (err.message || err), 'error'); }
                };
                cell.appendChild(b);
            }
            grid.appendChild(cell);
        }
        card.appendChild(grid);
        card.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '8px 0 0', lineHeight: '1.5' } }, [
            'Points are on the Challenger table at a NAC, Elite in brackets. Counts toward shows every standings list the result feeds: a national Cadet, Junior or Division I result is also a Y14 result.'
        ]));

        // Odds and the registered field for each entered event, folded.
        for (const e of w.decided) {
            const p = e.projections[name];
            if (!p || p.pending) continue;
            const det = el('div', { style: { marginTop: '8px' } });
            const btn = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label' }, [`${catLabel(e.category)} · odds and the field`]);
            const inner = el('div', { hidden: true, style: { marginTop: '6px' } });
            inner.appendChild(el('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } }, [
                stat('Fencers', `${e.entrants ?? p.field_n ?? '—'}`),
                stat("He'd start", ordinal(p.seed_form)),
                stat('Likely', ordinal(Math.round(p.median || p.exp))),
                ...(p.field_n > 64 ? [stat('Top 64', pct(p.p64))] : []),
                ...(p.field_n > 32 ? [stat('Top 32', pct(p.p32))] : []),
                stat('Top 16', pct(p.p16)), stat('Top 8', pct(p.p8)), stat('Top 4', pct(p.p4))
            ]));
            if (p.field_list?.length) inner.appendChild(fieldList(p, ctx));
            else inner.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '6px 0 0' } }, ['The registered field for this event is read overnight; names and odds appear once it has been.']));
            btn.onclick = () => { inner.hidden = !inner.hidden; };
            det.appendChild(btn); det.appendChild(inner);
            card.appendChild(det);
        }
        if (PARENT && w.decided.some((e) => e.ft_event_id)) {
            const e = w.decided.find((x) => x.ft_event_id);
            const rb = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label', style: { marginTop: '6px' } }, [refreshed.has(Number(e.ft_event_id)) ? 'Re-read the field' : 'Read the live field']);
            rb.onclick = async () => {
                rb.disabled = true; rb.textContent = 'Reading…';
                try { for (const x of w.decided.filter((y) => y.ft_event_id)) await refreshEvent(Number(x.ft_event_id), (msg) => { rb.textContent = msg; }, refreshed.has(Number(x.ft_event_id))); location.reload(); }
                catch (err) { rb.disabled = false; rb.textContent = 'Read the live field'; toast('Could not read: ' + (err.message || err), 'error'); }
            };
            card.appendChild(rb);
        }
        wrap.appendChild(card);
    }
    return wrap;
}

// ---------------------------------------------------------------------------
// Local club events from askFRED, within 60 miles of home: the experience
// events before the points events. Listed, never scored. Read daily.
// ---------------------------------------------------------------------------
async function localEventsCard(profile, home) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    const zip = home?.home_zip || (String(home?.home_address || '').match(/\b\d{5}\b/) || [])[0];
    wrap.appendChild(label('Local club events · for experience'));
    if (!zip) {
        wrap.appendChild(serif('Set a home ZIP on the Travel screen', '22px', WARN));
        return wrap;
    }
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supa.from('local_events').select('*').eq('zip', zip).gte('first_date', today).order('first_date').limit(60);
    // Only the age groups he can enter, from his birth year.
    const cats = ['y8', 'y10', 'y12', 'y14', 'cadet', 'junior'].filter((c) => c === 'y8' ? profile.birth_year >= 2018 : c === 'y10' ? profile.birth_year >= 2016 : eligible(c, profile));
    const fits = (ev) => {
        if (/para|unsanctioned|vet/i.test(String(ev.event || ''))) return false;
        const a = String(ev.age || '').toLowerCase().replace('-', '');
        return cats.includes(a) || a === 'youth' || a === 'open' || a === '';
    };
    const rows = (data || []).map((t) => ({ ...t, mine: (t.events || []).filter(fits) })).filter((t) => t.mine.length);
    wrap.appendChild(serif(rows.length ? `${rows.length} within 60 miles` : 'Nothing listed within 60 miles yet', '22px'));
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '4px 0 8px', lineHeight: '1.5' } }, [
        'Club and local tournaments from askFRED, read each morning. No national points; a Saturday of bouts close to home. Dates are the registration close, usually the event day.'
    ]));
    const list = el('div', {});
    const render = (n) => {
        list.innerHTML = '';
        rows.slice(0, n).forEach((t, i) => list.appendChild(el('div', { style: { padding: '8px 0', borderTop: i ? '1px solid var(--rule)' : 'none' } }, [
            el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' } }, [
                el('span', { style: { color: INK, fontSize: '14px', fontWeight: '600' } }, [t.tournament]),
                el('span', { class: 'label', style: { color: INK_MUTE } }, [`${fmtDay(t.first_date)} · ${t.distance_mi} mi`])
            ]),
            el('div', { class: 'label', style: { color: INK_MUTE, marginTop: '2px' } }, [t.mine.map((e) => e.event.replace(/Men's Foil|Mixed Foil/i, '').trim()).join(' · ') + (t.location ? ` · ${String(t.location).split(',').slice(-3, -1).join(',').trim()}` : '')])
        ])));
    };
    render(8);
    wrap.appendChild(list);
    if (rows.length > 8) {
        const btn = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label', style: { marginTop: '8px' } }, [`All ${rows.length}`]);
        btn.onclick = () => { render(rows.length); btn.remove(); };
        wrap.appendChild(btn);
    }
    return wrap;
}

// ---------------------------------------------------------------------------
// The calendar, national and regional, best points per dollar first. Cost is
// per person so a parent multiplies by however many are going.
// ---------------------------------------------------------------------------
function rankedCalendar(events, ctx, national) {
    const name = ctx.profile.name;
    const rows = events.filter((e) => NATIONAL.has(e.tier) === national && e.projections[name]?.points_exp != null && e.category !== 'junior' || (national && NATIONAL.has(e.tier) && e.projections[name]?.points_exp != null && e.category === 'junior'))
        .map((e) => { const pts = e.projections[name].points_exp || 0; const pp = e.cost?.per_person || 0; return { e, pts, pp, ppd: pp > 0 ? pts / pp * 100 : 0 }; })
        .sort((a, b) => b.ppd - a.ppd);
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    wrap.appendChild(label(`${national ? 'National' : 'Regional'} calendar · ${rows.length} events`));
    wrap.appendChild(serif(national ? 'NACs, JO, SJCC, Nationals by points per dollar' : 'SYCs, RJCCs, RYCs by points per dollar', '22px'));
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '4px 0 8px', lineHeight: '1.5' } }, ['Cost is per person: a return fare, half a hotel room per night, the entry, half the driving. Multiply by who is going.']));
    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 64px 64px 60px', columnGap: '10px', rowGap: '6px', alignItems: 'baseline', marginTop: '4px' } });
    const head = (t, right) => el('span', { class: 'label', style: { color: INK_MUTE, textAlign: right ? 'right' : 'left' } }, [t]);
    grid.appendChild(head('Event')); grid.appendChild(head('Points', true)); grid.appendChild(head('Per person', true)); grid.appendChild(head('Pts/$100', true));
    const render = (n) => {
        [...grid.querySelectorAll('[data-row]')].forEach((x) => x.remove());
        rows.slice(0, n).forEach(({ e, pts, pp, ppd }) => {
            const v = verdict(e, ctx);
            const cells = [
                el('div', { 'data-row': '1', style: { minWidth: 0 } }, [
                    el('div', { style: { color: INK, fontSize: '14px', fontWeight: e.group === 'registered' ? '700' : '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [e.tournament]),
                    el('div', { class: 'label', style: { color: INK_MUTE } }, [`${catLabel(e.category)} · ${fmtDay(e.start_date)} · ${e.travel || ''} · `, el('span', { style: { color: v.tone, fontWeight: '700' } }, [v.word])])
                ]),
                el('span', { 'data-row': '1', class: 'num', style: { color: pts >= 25 ? GOOD : INK, textAlign: 'right' } }, [pts.toFixed(0)]),
                el('span', { 'data-row': '1', class: 'num', style: { color: INK, textAlign: 'right' } }, [pp > 0 ? money(pp) : '—']),
                el('span', { 'data-row': '1', class: 'num', style: { color: ppd >= 5 ? GOOD : INK, textAlign: 'right', fontWeight: '700' } }, [pp > 0 ? ppd.toFixed(1) : '—'])
            ];
            cells.forEach((c) => grid.appendChild(c));
        });
    };
    render(10);
    wrap.appendChild(grid);
    if (rows.length > 10) {
        const btn = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label', style: { marginTop: '8px' } }, [`All ${rows.length}`]);
        btn.onclick = () => { render(rows.length); btn.remove(); };
        wrap.appendChild(btn);
    }
    return wrap;
}

// ---------------------------------------------------------------------------
// One intention group, its events inside.
// ---------------------------------------------------------------------------
function groupCard(key, title, sub, rows, ctx, refreshed) {
    const name = ctx.profile.name;
    const P = (e) => e.projections[name]?.points_exp || 0;
    const ppd = (e) => e.cost?.total > 0 ? P(e) / e.cost.total * 100 : -1;
    const sorted = key === 'value' ? rows.slice().sort((a, b) => ppd(b) - ppd(a))
        : key === 'skip' ? rows.slice().sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))
        : rows.slice().sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    wrap.appendChild(label(`${rows.length} event${rows.length > 1 ? 's' : ''}`));
    wrap.appendChild(serif(title, '24px', key === 'skip' ? INK_MUTE : INK));
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '4px 0 8px', lineHeight: '1.5' } }, [sub]));
    const list = el('div', {});
    const render = (limit) => {
        list.innerHTML = '';
        sorted.slice(0, limit).forEach((e, i) => list.appendChild(eventRow(e, i, ctx, refreshed, key)));
    };
    if (key === 'skip') {
        const btn = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label' }, [`Show the ${rows.length}`]);
        btn.onclick = () => { render(rows.length); btn.remove(); };
        wrap.appendChild(btn);
    } else render(rows.length);
    wrap.appendChild(list);
    return wrap;
}

function eventRow(e, i, ctx, refreshed, group) {
    const name = ctx.profile.name;
    const p = e.projections[name] || {};
    const cost = e.cost || { total: 0 };
    const pts = p.points_exp || 0;
    const ppd = cost.total > 0 && p.points_exp != null ? pts / cost.total * 100 : null;
    const finishColor = p.p8 >= 0.6 ? GOOD : p.p16 >= 0.5 ? INK : WARN;
    const row = el('div', { style: { padding: '12px 0', borderTop: i === 0 ? '1px solid var(--rule)' : '1px solid var(--rule)', display: 'grid', gridTemplateColumns: '1fr', gap: '6px' } });
    row.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } }, [
        el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '600', fontSize: '19px', color: INK } }, [e.tournament]),
        el('span', { class: 'label', style: { color: INK_MUTE } }, [`${catLabel(e.category)} · ${tierLabel(e.tier)} · ${fmtRange(e.start_date, e.end_date)}${p.live ? ' · live' : ''}`])
    ]));
    const travelWord = e.travel === 'local' ? 'drive, no hotel' : e.travel === 'drive' ? 'drive' : e.travel === 'fly' ? 'fly' : '';
    row.appendChild(el('div', { class: 'label', style: { color: INK_MUTE } }, [[e.city, e.venue, travelWord].filter(Boolean).join(' · ') || 'City not set']));
    // The verdict first, in the parent's words.
    const v = verdict(e, ctx);
    row.appendChild(el('p', { style: { margin: '4px 0 2px', fontSize: '14px', lineHeight: '1.5', color: INK } }, [
        el('span', { class: 'label', style: { color: v.tone, fontWeight: '700', marginRight: '8px' } }, [v.word]),
        v.why
    ]));
    if (p.pending) {
        row.appendChild(el('p', { style: { color: WARN, fontSize: '13px', margin: '2px 0 0' } }, ['Field not read yet.']));
    } else {
        const add = marginalPoints(e, ctx);
        const decided = group === 'registered' || group === 'considering';
        const stats = [
            stat('Fencers', `${e.entrants ?? p.field_n ?? '—'}`),
            stat("He'd start", ordinal(p.seed_form) + (p.seed_official && p.seed_official !== p.seed_form ? ` (${ordinal(p.seed_official)})` : ''), p.seed_form <= 8 ? GOOD : INK),
            ...(p.seed_pool ? [stat('By pools', ordinal(p.seed_pool), p.seed_pool > p.seed_form + 4 ? WARN : INK)] : []),
            stat('Likely finish', ordinal(Math.round(p.median || p.exp)), finishColor),
            ...(decided && p.p64 != null && p.field_n > 64 ? [stat('Top 64', pct(p.p64))] : []),
            ...(decided && p.p32 != null && p.field_n > 32 ? [stat('Top 32', pct(p.p32))] : []),
            ...(decided && p.p16 != null ? [stat('Top 16', pct(p.p16))] : []),
            stat('Top 8', pct(p.p8), p.p8 >= 0.6 ? GOOD : INK),
            ...((decided || e.tier === 'syc') && p.p4 != null ? [stat('Top 4', pct(p.p4), p.p4 >= 0.3 ? GOOD : INK)] : []),
            stat('Points on the day', p.points_exp == null ? '—' : pts.toFixed(0), pts >= 25 ? GOOD : INK),
            ...(add != null ? [stat('Adds to ranking', add.toFixed(0), add >= 20 ? GOOD : add === 0 ? BAD : INK)] : [])
        ];
        if (COSTS) {
            if (group === 'addon' && cost.marginal != null) stats.push(stat('His cost', money(cost.marginal), GOOD));
            else stats.push(stat('Per person', cost.per_person > 0 ? money(cost.per_person) : '—', cost.live ? GOOD : INK));
            if (group === 'value' || group === 'anchor' || decided) stats.push(stat('Points per $100', ppd == null ? '—' : ppd.toFixed(1), ppd >= 5 ? GOOD : INK));
        }
        row.appendChild(el('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '2px' } }, stats));
        // The registered field, strongest first, with his chance in one bout.
        if (decided && p.field_list?.length) row.appendChild(fieldList(p, ctx));
    }
    const note = [];
    if (group === 'addon' && ctx.sibling) note.push(`${ctx.sibling.name} is going. ${e.travel === 'fly' ? `Add his fare${COSTS ? `, about ${money(cost.flight_pp * 2)} return` : ''},` : 'No extra travel,'} plus the entry.`);
    if (e.tier === 'syc' && (e.category === 'y12' || e.category === 'y14') && pts >= 20) {
        const keep = ctx.events.filter((x) => ctx.sycKeep.has(x.id) && x.category === e.category);
        if (keep[0] === e) note.push('The SYC that counts, on today\'s fields and prices.');
        else if (keep.length && keep[1] === e) note.push(`Only one SYC counts; ${keep[0].tournament} is the first choice. This one is the backup if that weekend goes badly.`);
        else if (keep.length) note.push(`Only one SYC counts and ${keep[0].tournament} is the better bet. Real points here, but they would replace, not add.`);
    }
    if (COSTS && cost.live) note.push(`Fare is live from the Travel screen: ${money(cost.flight_pp)} per person each way.`);
    else if (COSTS && e.travel === 'fly' && group !== 'addon') note.push(`Fare estimated at ${money(cost.flight_pp)} per person one way.`);
    if (COSTS && cost.nights && group !== 'addon') note.push(`${cost.nights} night${cost.nights > 1 ? 's' : ''} at ${money(cost.hotel_night)}.`);
    if (p.live && p.trend) {
        const bits = Object.entries(p.trend).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
        if (bits.length) note.push(`Registered field on their 90-day trend: ${bits.join(', ')}.`);
    } else if (e.plan_note && group !== 'skip') note.push(e.plan_note);
    if (note.length) row.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '2px 0 0', lineHeight: '1.5' } }, [note.join(' ')]));

    if (p.live && p.neighbours?.length && group !== 'skip') {
        row.appendChild(label('Around his seed · their recent form', INK_MUTE, { marginTop: '6px' }));
        row.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr', gap: '4px', marginTop: '2px' } }, p.neighbours.map((n) => {
            const col = n.tag === 'rising' ? WARN : n.tag === 'fading' || n.tag === 'inactive' ? GOOD : INK;
            return el('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } }, [
                el('a', { href: `https://fencingtracker.com/p/${n.tracker_id}/x`, target: '_blank', rel: 'noopener', style: { color: INK, fontSize: '14px', fontWeight: n.tag === 'rising' ? '700' : '500', textDecoration: 'none' } }, [n.name]),
                el('span', { class: 'num', style: { color: INK, fontSize: '13px' } }, [String(n.strength)]),
                n.tag !== 'steady' ? el('span', { class: 'label', style: { color: col, fontWeight: '700' } }, [n.tag]) : null,
                el('span', { class: 'label', style: { color: INK_MUTE } }, [n.form || ''])
            ].filter(Boolean));
        })));
    }
    if (PARENT && e.ft_event_id && group !== 'skip') {
        const rb = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label', style: { marginTop: '6px', justifySelf: 'start' } }, [refreshed.has(Number(e.ft_event_id)) ? 'Re-read the field' : 'Read the live field']);
        rb.onclick = async () => {
            rb.disabled = true; rb.textContent = 'Reading…';
            try { await refreshEvent(Number(e.ft_event_id), (msg) => { rb.textContent = msg; }, refreshed.has(Number(e.ft_event_id))); location.reload(); }
            catch (err) { rb.disabled = false; rb.textContent = 'Read the live field'; toast('Could not read: ' + (err.message || err), 'error'); }
        };
        row.appendChild(rb);
    }
    return row;
}

// The registered fencers, strongest first, and his chance in a bout against
// each on his form. Folded past the first twelve.
function fieldList(p, ctx) {
    const wrap = el('div', { style: { marginTop: '8px' } });
    wrap.appendChild(label(`Registered fencers · strongest first · his chance in a bout`, INK_MUTE));
    const rows = p.field_list;
    const list = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr', gap: '3px', marginTop: '4px' } });
    const render = (n) => {
        list.innerHTML = '';
        rows.slice(0, n).forEach((f, i) => {
            const col = f.p_beat >= 0.6 ? GOOD : f.p_beat <= 0.35 ? BAD : INK;
            list.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '28px 1fr 56px 52px', gap: '8px', alignItems: 'baseline' } }, [
                el('span', { class: 'label', style: { color: INK_MUTE } }, [String(i + 1)]),
                el('span', { style: { color: INK, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [
                    el('a', { href: `https://fencingtracker.com/p/${f.tracker_id}/x`, target: '_blank', rel: 'noopener', style: { color: INK, textDecoration: 'none', fontWeight: f.tag === 'rising' ? '700' : '500' } }, [f.name]),
                    f.tag !== 'steady' ? el('span', { class: 'label', style: { color: f.tag === 'rising' ? WARN : GOOD, marginLeft: '6px' } }, [f.tag]) : null
                ].filter(Boolean)),
                el('span', { class: 'num', style: { color: INK, fontSize: '13px', textAlign: 'right' } }, [String(f.strength)]),
                el('span', { class: 'num', style: { color: col, fontSize: '13px', fontWeight: '700', textAlign: 'right' } }, [pct(f.p_beat)])
            ]));
        });
    };
    render(12);
    wrap.appendChild(list);
    if (rows.length > 12) {
        const btn = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label', style: { marginTop: '6px' } }, [`All ${rows.length}`]);
        btn.onclick = () => { render(rows.length); btn.remove(); };
        wrap.appendChild(btn);
    }
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '6px 0 0', lineHeight: '1.5' } }, [
        'Chance is one 15-touch bout on his current form against theirs, with their last 90 days counted. Rising means their strength moved up 40 or more in three months.'
    ]));
    return wrap;
}

// ---------------------------------------------------------------------------
// Live scoring from the on-demand cache: entrants + each fencer's windows.
// ---------------------------------------------------------------------------
async function applyLiveForecasts(events, refreshed, profile, myForm) {
    const liveIds = events.map((e) => Number(e.ft_event_id)).filter((id) => id && refreshed.has(id));
    if (!liveIds.length) return;
    const { data: entrants } = await supa.from('ft_event_entrants').select('ft_event_id,tracker_id,name,strength_de').in('ft_event_id', liveIds);
    if (!entrants?.length) return;
    const ids = [...new Set(entrants.map((x) => Number(x.tracker_id)))];
    const snaps = new Map();
    for (let i = 0; i < ids.length; i += 250) {
        const { data } = await supa.from('fencer_snapshot').select('tracker_id,strength_de,strength_pool,de_now,de_90d,de_180d,pool_now,pool_90d,pool_180d,events_90d,events_180d,results_90d,median_pct_90d,best_pct_90d,results_180d,median_pct_180d,last_event,fetched_at').in('tracker_id', ids.slice(i, i + 250));
        for (const s of data || []) snaps.set(Number(s.tracker_id), s);
    }
    const byEvent = new Map();
    for (const x of entrants) { const k = Number(x.ft_event_id); if (!byEvent.has(k)) byEvent.set(k, []); byEvent.get(k).push(x); }
    for (const e of events) {
        const list = byEvent.get(Number(e.ft_event_id));
        if (!list || !e.category) continue;
        const f = forecast({ entrants: list, snapshots: snaps, myStrength: myForm, myOfficial: profile.strength_de ?? myForm, myPool: profile.strength_pool ?? null, myTrackerId: profile.tracker_id, category: e.category, tier: e.tier });
        if (!f) continue;
        e.projections[profile.name] = { ...(e.projections[profile.name] || {}), ...f, pending: false };
        e.entrants = list.length;
        e.refreshed_at = refreshed.get(Number(e.ft_event_id))?.last_refreshed_at;
    }
}

// ---------------------------------------------------------------------------
// Strength: official, and what the last 3 and 6 months of bouts say.
// ---------------------------------------------------------------------------
function strengthCard(profile, ts, myForm, drill = {}) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    const de = profile.strength_de, pool = profile.strength_pool;
    const gap90 = ts[90]?.perf_minus_official;
    wrap.appendChild(label('How he is fencing · last 3 and 6 months'));
    wrap.appendChild(serif(
        gap90 == null ? `${de ?? '—'} official` :
        gap90 >= 60 ? `Fencing ${gap90} above his seed` :
        gap90 <= -60 ? `Fencing ${-gap90} below his seed` : 'Fencing at his seed',
        '28px', gap90 >= 60 ? GOOD : gap90 <= -60 ? BAD : INK));
    wrap.appendChild(el('div', { class: 'label', style: { color: INK_MUTE, margin: '2px 0 10px' } }, [
        `Official DE strength ${de ?? '—'} · pool strength ${pool ?? '—'} · seeded on this screen at ${myForm}`
    ]));
    // Every number is a door. Tap it and the bouts it counts open under the
    // grid, grouped the way the true_strength view groups them: the window is
    // the last 90 or 180 days, "stronger" is an opponent rated above his
    // official DE strength, "weaker" at or below it, rated opponents only.
    const all = (drill.bouts || []).filter((b) => b.opponent_strength != null);
    const journal = drill.journal || [];
    const sinceFor = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const inWindow = (days) => all.filter((b) => b.bout_date >= sinceFor(days));
    const rowsSpec = [
        ['Performance', (t) => t.performance_rating, (t) => t.perf_minus_official >= 60 ? GOOD : t.perf_minus_official <= -60 ? BAD : INK, 'all',
            'Every rated bout in the window. The performance rating is the strength that would produce exactly this record against exactly these opponents: wins over strong fencers lift it, losses to weaker ones sink it.'],
        ['vs official', (t) => (t.perf_minus_official > 0 ? '+' : '') + t.perf_minus_official, (t) => t.perf_minus_official >= 60 ? GOOD : t.perf_minus_official <= -60 ? BAD : INK, 'all',
            `The gap between that performance and his official DE strength of ${de ?? '—'}. These are the bouts behind it.`],
        ['Record', (t) => `${t.wins}–${t.bouts - t.wins}`, () => INK, 'all', 'Wins and losses, pools and DE together, newest first.'],
        ['Beat stronger', (t) => `${t.wins_vs_stronger} of ${t.vs_stronger}`, (t) => t.wins_vs_stronger > 0 ? GOOD : INK, 'stronger',
            `Bouts against fencers rated above his official ${de ?? '—'}, strongest first. The wins are the ones that move his ranking.`],
        ['Lost to weaker', (t) => `${t.losses_vs_weaker} of ${t.vs_weaker}`, (t) => t.losses_vs_weaker > t.vs_weaker * 0.25 ? BAD : INK, 'weaker',
            `Bouts against fencers rated at or below ${de ?? '—'}, losses first. Each loss here is a bout he was expected to win.`],
        ['Best win', (t) => t.best_win_strength ?? '—', () => GOOD, 'best', 'The strongest fencer he beat in the window.'],
        ['Worst loss', (t) => t.worst_loss_strength ?? '—', () => BAD, 'worst', 'The weakest fencer he lost to in the window.'],
        ['Bouts', (t) => t.bouts, () => INK, 'all', 'Every bout against a rated opponent in the window.']
    ];
    const byDate = (a, b) => b.bout_date.localeCompare(a.bout_date) || (a.bout_no || 0) - (b.bout_no || 0);
    const pick = (kind, days) => {
        const w = inWindow(days);
        if (kind === 'stronger') return w.filter((b) => b.opponent_strength > de).sort((a, b) => b.opponent_strength - a.opponent_strength || byDate(a, b));
        if (kind === 'weaker') return w.filter((b) => b.opponent_strength <= de).sort((a, b) => (a.result === 'D' ? 0 : 1) - (b.result === 'D' ? 0 : 1) || byDate(a, b));
        if (kind === 'best') { const wins = w.filter((b) => b.result === 'V'); const m = Math.max(...wins.map((b) => b.opponent_strength)); return wins.filter((b) => b.opponent_strength === m); }
        if (kind === 'worst') { const losses = w.filter((b) => b.result === 'D'); const m = Math.min(...losses.map((b) => b.opponent_strength)); return losses.filter((b) => b.opponent_strength === m); }
        return w.slice().sort(byDate);
    };
    const journalFor = (b) => journal.find((x) => x.source_bout_id === b.id)
        || journal.find((x) => x.opponent_tracker_id && x.opponent_tracker_id === b.opponent_tracker_id && x.date === b.bout_date && x.my_score === b.score_for && x.their_score === b.score_against);
    const fmtDay = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const boutRow = (b) => {
        const won = b.result === 'V';
        const j = journalFor(b);
        const right = el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexShrink: '0' } }, [
            el('span', { class: 'num', style: { color: won ? GOOD : BAD, fontWeight: '700', fontSize: '15px', whiteSpace: 'nowrap' } }, [`${won ? 'W' : 'L'} ${b.score_for}–${b.score_against}`])
        ]);
        if (j) right.appendChild(el('a', { href: `#bouts/show?id=${j.id}`, class: 'btn btn-ghost btn-sm btn-mono-label', style: { textDecoration: 'none' }, title: j.reflection || 'In the journal' }, ['Journal']));
        else if (!won) { const btn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-mono-label' }, ['Log it']); btn.onclick = () => go('bouts/new', { from: b.id }); right.appendChild(btn); }
        return el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '6px 0', borderTop: '1px solid var(--rule)' } }, [
            el('div', { style: { minWidth: '0' } }, [
                el('div', { style: { color: INK, fontSize: '14px', fontWeight: '600' } }, [b.opponent || 'Unknown', el('span', { class: 'num', style: { color: b.opponent_strength > de ? WARN : INK_MUTE, fontWeight: '600', marginLeft: '8px', fontSize: '13px' } }, [String(b.opponent_strength)])]),
                el('div', { class: 'label', style: { color: INK_MUTE, marginTop: '2px' } }, [[fmtDay(b.bout_date), b.tournament, catLabel(b.category), stageOf(b) === 'de' ? 'DE' : 'Pool', b.difficulty].filter(Boolean).join(' · ')])
            ]),
            right
        ]);
    };
    const detail = el('div', { style: { marginTop: '12px', borderTop: '1px solid var(--rule)', paddingTop: '10px' } });
    detail.hidden = true;
    let open = null;
    const cells = new Map();
    const show = (i, days) => {
        const key = `${i}:${days}`;
        for (const [k, c] of cells) c.style.borderBottom = k === key && open !== key ? `2px solid ${INK}` : '2px solid transparent';
        if (open === key) { open = null; detail.hidden = true; return; }
        open = key;
        const [lbl, , , kind, why] = rowsSpec[i];
        const list = pick(kind, days);
        detail.innerHTML = '';
        detail.appendChild(label(`${lbl} · last ${days === 90 ? '3' : '6'} months · ${list.length} bout${list.length === 1 ? '' : 's'}`, INK, { fontWeight: '700' }));
        detail.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '2px 0 4px', lineHeight: '1.5' } }, [why]));
        if (!list.length) detail.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '6px 0 0' } }, ['No bouts in this window yet.']));
        for (const b of list) detail.appendChild(boutRow(b));
        detail.hidden = false;
    };
    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(92px, 1.2fr) 1fr 1fr', columnGap: '12px', rowGap: '6px', alignItems: 'baseline' } });
    grid.appendChild(el('span', {}, ['']));
    grid.appendChild(label('Last 3 months', INK, { fontWeight: '700' }));
    grid.appendChild(label('Last 6 months', INK, { fontWeight: '700' }));
    const t90 = ts[90], t180 = ts[180];
    const cell = (t, get, col, i, days) => {
        if (!t || !t.bouts) return el('span', { class: 'label', style: { color: INK_MUTE } }, ['—']);
        const btn = el('button', {
            type: 'button', class: 'num', title: 'Show the bouts behind this number',
            style: { background: 'none', border: 'none', borderBottom: '2px solid transparent', padding: '0', margin: '0', cursor: 'pointer', font: 'inherit', color: col(t), fontSize: '18px', fontWeight: '600', textDecoration: 'underline dotted', textDecorationColor: '#9CA3AF', textUnderlineOffset: '5px', textAlign: 'left' }
        }, [String(get(t))]);
        btn.onclick = () => show(i, days);
        cells.set(`${i}:${days}`, btn);
        return btn;
    };
    rowsSpec.forEach(([lbl, get, col], i) => { grid.appendChild(label(lbl)); grid.appendChild(cell(t90, get, col, i, 90)); grid.appendChild(cell(t180, get, col, i, 180)); });
    wrap.appendChild(grid);
    if (all.length) wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '8px 0 0' } }, ['Tap any number to see the bouts behind it.']));
    wrap.appendChild(detail);
    if (de && pool) {
        const g = de - pool;
        wrap.appendChild(el('p', { style: { color: g >= 200 ? WARN : INK, fontSize: '13px', margin: '12px 0 0', lineHeight: '1.5', fontWeight: g >= 200 ? '700' : '500' } }, [
            g >= 200 ? `Pools trail his DE by ${g} points. He is drawn into brackets as a weaker fencer than he is, and meets the top seeds a round early.`
                : g <= -100 ? `Pools run ${-g} ahead of his DE: he seeds well, then gives it back in the bracket. The work is in the 15-touch bout.`
                : 'Pools and DE are in step; his seed matches how he fences.'
        ]));
    }
    return wrap;
}

// ---------------------------------------------------------------------------
// Fencers to watch: the ones just above him on the standings. What they
// count, where they are registered, and which of those weekends are on his
// plan. Read on demand, one profile at a time, cached three days.
// ---------------------------------------------------------------------------
async function peersCard(profile, events) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    const { data: peers } = await supa.from('peers').select('*').eq('profile_id', profile.id).order('added_at');
    const ids = (peers || []).map((p) => Number(p.tracker_id));
    const { data: snaps } = ids.length ? await supa.from('peer_snapshot').select('*').in('tracker_id', ids) : { data: [] };
    const snapOf = new Map((snaps || []).map((s) => [Number(s.tracker_id), s]));
    wrap.appendChild(label('Fencers to watch · just above him on the standings'));
    wrap.appendChild(serif(peers?.length ? `${peers.length} fencers` : 'Nobody watched yet', '24px'));
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '4px 0 10px', lineHeight: '1.5' } }, [
        'The kids a few places above him: what they enter, what they count, and where he will meet them. The pattern to copy is theirs, not the crowd\'s.'
    ]));
    const planTournaments = new Set(events.filter((e) => e.group && e.group !== 'skip').map((e) => e.tournament.toLowerCase()));
    const list = el('div', {});
    for (const p of peers || []) {
        const s = snapOf.get(Number(p.tracker_id));
        const row = el('div', { style: { padding: '10px 0', borderTop: '1px solid var(--rule)' } });
        row.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' } }, [
            el('a', { href: `https://fencingtracker.com/p/${p.tracker_id}/x`, target: '_blank', rel: 'noopener', style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '19px', color: INK, textDecoration: 'none' } }, [s?.name || p.name || `#${p.tracker_id}`]),
            el('span', { class: 'label', style: { color: INK_MUTE } }, [[p.note, s?.club, s?.rating, s?.birth_year ? `born ${s.birth_year}` : null, s?.strength_de ? `DE ${s.strength_de}` : null].filter(Boolean).join(' · ')])
        ]));
        if (!s) {
            row.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '4px 0 0' } }, ['Not read yet.']));
        } else {
            const regs = (s.registrations || []).filter((r) => r.d >= new Date().toISOString().slice(0, 10) || !r.d);
            const meet = regs.filter((r) => planTournaments.has(String(r.tournament).toLowerCase()));
            const byT = new Map();
            for (const r of regs) { const k = r.tournament; if (!byT.has(k)) byT.set(k, []); byT.get(k).push(String(r.event).replace(/\s*\(.*$/, '').replace(/Men's Foil/i, '').trim()); }
            if (byT.size) {
                row.appendChild(el('p', { style: { color: INK, fontSize: '13px', margin: '4px 0 0', lineHeight: '1.5' } }, [
                    el('b', {}, ['Entered: ']), [...byT.entries()].map(([t, ev]) => `${t} (${ev.join(', ')})`).join(' · ')
                ]));
            }
            if (meet.length) {
                row.appendChild(el('p', { style: { color: WARN, fontSize: '13px', margin: '2px 0 0', lineHeight: '1.5', fontWeight: '700' } }, [
                    `On his plan too: ${[...new Set(meet.map((r) => r.tournament))].join(', ')}.`
                ]));
            }
            const res = (s.results || []).slice(0, 6);
            if (res.length) {
                row.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '4px 0 0', lineHeight: '1.5' } }, [
                    el('b', { style: { color: INK } }, ['Recent: ']), res.map((r) => `${r.event.replace(/Men's Foil/i, '').trim()} ${r.place}/${r.field} (${String(r.d).slice(5)})`).join(' · ')
                ]));
            }
        }
        const btn = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label', style: { marginTop: '6px' } }, [s ? 'Re-read' : 'Read his record']);
        btn.onclick = async () => {
            btn.disabled = true; btn.textContent = 'Reading…';
            try {
                const { data, error } = await supa.functions.invoke('refresh-peer', { body: { tracker_id: Number(p.tracker_id), force: Boolean(s) } });
                if (error || data?.error) throw new Error(error?.message || data?.error);
                location.reload();
            } catch (err) { btn.disabled = false; btn.textContent = 'Read his record'; toast('Could not read: ' + (err.message || err), 'error'); }
        };
        row.appendChild(btn);
        list.appendChild(row);
    }
    wrap.appendChild(list);
    // Add one by pasting a FencingTracker profile link.
    const input = el('input', { type: 'text', class: 'field-input', placeholder: 'https://fencingtracker.com/p/100316398/…', autocomplete: 'off', style: { marginTop: '10px', color: INK } });
    const add = el('button', { class: 'btn btn-mono-label', style: { width: '100%', marginTop: '8px' } }, ['Watch this fencer']);
    add.onclick = async () => {
        const m = String(input.value).match(/\/p\/(\d{6,10})/) || String(input.value).match(/(\d{6,10})/);
        if (!m) { toast('Paste a FencingTracker profile link', 'error'); return; }
        add.disabled = true; add.textContent = 'Reading…';
        try {
            const tid = Number(m[1]);
            const { data, error } = await supa.functions.invoke('refresh-peer', { body: { tracker_id: tid } });
            if (error || data?.error) throw new Error(error?.message || data?.error);
            await safeWrite({ table: 'peers', op: 'upsert', onConflict: 'profile_id,tracker_id', payload: { profile_id: profile.id, tracker_id: tid, name: data?.name || null } });
            location.reload();
        } catch (err) { add.disabled = false; add.textContent = 'Watch this fencer'; toast('Could not add: ' + (err.message || err), 'error'); }
    };
    wrap.appendChild(input); wrap.appendChild(add);
    return wrap;
}

// For the parent who has never seen the system: how points work, in the
// fewest words that are still true. Folded by default; one tap opens it.
function primerCard(goals) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    wrap.appendChild(label('New to this? How the points work'));
    const cat = goals.focus_category;
    const youth = cat === 'y12' || cat === 'y14';
    const lines = youth ? [
        'National ranking comes from national points. Only three kinds of event pay them for his age: Super Youth Circuit (SYC) weekends, NACs, and Summer Nationals.',
        'Regional youth events (RYC) pay no national points at all, however well he does. They are for confidence and practice.',
        'His four best results count. Only one of them can be an SYC, so a second and third SYC add nothing to his ranking, even with a medal.',
        cat === 'y14' ? 'Cadet national results count for Y14 too, which is why a Cadet NAC entry can be worth more to his Y14 ranking than another SYC.' : 'A NAC pays more than an SYC, but only if he finishes in the top 32 of a much deeper field.',
        'Going to more weekends does not mean more points. Going to the right four does. Every event below says what it adds to his total, and Skip means it adds nothing worth the money.'
    ] : [
        'Cadet national points now come from regional events (RJCC, RCC) as well as NACs, and his six best results count.',
        'A regional top 8 is 36.6 points; anywhere in the top 64 is 22.2. A NAC pays more only in the Elite bracket; in Challenger a top 64 is 31.8.',
        'Going to more weekends does not mean more points. Six good results do. Every event below says what it adds to his total.'
    ];
    const list = el('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', color: INK, fontSize: '13px', lineHeight: '1.55' }, hidden: true }, lines.map((t) => el('li', { style: { marginBottom: '4px' } }, [t])));
    const btn = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label', style: { marginTop: '6px' } }, ['Read it, one minute']);
    btn.onclick = () => { list.hidden = !list.hidden; btn.textContent = list.hidden ? 'Read it, one minute' : 'Hide'; };
    wrap.appendChild(btn); wrap.appendChild(list);
    return wrap;
}

// What he is chasing this season, in one card, so the plan below reads right.
function goalsCard(profile, goals, sibling) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    wrap.appendChild(label('This season · what he is chasing'));
    const focus = catLabel(goals.focus_category);
    wrap.appendChild(serif(goals.pressure === 'development' ? `${focus} ranking, without the pressure` : `${focus} national ranking`, '26px'));
    const bits = [];
    if (goals.secondary?.length) bits.push(`${goals.secondary.map(catLabel).join(' and ')}: points along the way, entered when he is there anyway or the trip pays for itself.`);
    if (goals.ride_along?.length) bits.push(`${goals.ride_along.map(catLabel).join(' and ')}: only when the family is at the venue${sibling ? ` for ${sibling.name}` : ''}, no points pressure.`);
    if (goals.travels_with && sibling) bits.push(`Travels with ${sibling.name}; NAC weekends are ${sibling.name}'s, and ${profile.name}'s cost there is his fare and entries.`);
    if (goals.notes) bits.push(goals.notes);
    wrap.appendChild(el('p', { style: { color: INK, fontSize: '13px', margin: '6px 0 0', lineHeight: '1.55' } }, [bits.join(' ')]));
    return wrap;
}

function howToRead(profile, sibling) {
    return el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } }, [
        label('How to read the plan'),
        el('p', { style: { color: INK, fontSize: '13px', margin: '6px 0 0', lineHeight: '1.55' } }, [
            el('b', {}, ['Field']), ' is who is registered. Events marked live were read on demand; the rest use the nightly snapshot. ',
            el('b', {}, ['Seed']), ' is his place in that field on form strength, official seed in brackets; ', el('b', {}, ['by pools']), ' is where his pool strength would draw him. ',
            el('b', {}, ['Expected']), ' is the median finish of a simulated bracket. ',
            el('b', {}, ['Points']), ' are national points for that finish under the 2026-27 tables, weighted by how likely each finish is. ',
            ...(COSTS ? [
                el('b', {}, ['Per person']), ` is a return fare, half a hotel room per night, the entry and half the driving from ${HOME?.city || 'home'}; multiply by who is going. A live fare from the Travel screen replaces the estimate. `,
                AIRPORTS.length ? `Airports within 75 minutes of home: ${AIRPORTS.map((a) => `${a.code} ${a.miles} mi`).join(', ')}. ` : '',
                sibling ? `Where ${sibling.name} is going anyway, ${profile.name}'s cost is shown as his fare and entry only. ` : ''
            ] : []),
            'Cadet regionals count toward national points this season. Youth RYCs do not; only SYCs and NACs do, and only one SYC counts.'
        ])
    ]);
}

// ---------------------------------------------------------------------------
// Add an event: paste the FencingTracker link.
// ---------------------------------------------------------------------------
function addEventCard(profile) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    wrap.appendChild(label('Add an event'));
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '6px 0 10px', lineHeight: '1.5' } }, [
        'Paste the FencingTracker link of the event he is registered for (fencingtracker.com/event/…). The entry list is read once and every registered fencer is scored on their recent form.'
    ]));
    const input = el('input', { type: 'text', class: 'field-input', placeholder: 'https://fencingtracker.com/event/12345', autocomplete: 'off', style: { color: INK } });
    const cat = el('select', { class: 'field-input', style: { marginTop: '8px', color: INK } }, [
        el('option', { value: '' }, ['Category: read from the event name']),
        ...CAT_ORDER.map((c) => el('option', { value: c }, [catLabel(c)]))
    ]);
    const btn = el('button', { class: 'btn btn-primary btn-mono-label', style: { width: '100%', marginTop: '10px' } }, ['Add and read the field']);
    const status = el('div', { class: 'label', style: { color: INK_MUTE, marginTop: '8px', minHeight: '16px' } }, ['']);
    btn.onclick = async () => {
        const m = String(input.value).match(/(\d{4,7})/);
        if (!m) { toast('Paste a FencingTracker event link', 'error'); return; }
        const ftEventId = Number(m[1]);
        btn.disabled = true; btn.textContent = 'Reading…';
        try {
            await safeWrite({ table: 'member_events', op: 'upsert', onConflict: 'profile_id,ft_event_id', payload: { profile_id: profile.id, ft_event_id: ftEventId, category: cat.value || null } });
            const res = await refreshEvent(ftEventId, (msg) => { status.textContent = msg; });
            if (res?.title) {
                await safeWrite({ table: 'member_events', op: 'update', match: { profile_id: profile.id, ft_event_id: ftEventId }, payload: { category: cat.value || categoryOf(res.title), tournament: res.title, event_date: res.event_date } });
            }
            toast(`Read ${res?.entrants ?? 0} entrants`);
            location.reload();
        } catch (e) {
            btn.disabled = false; btn.textContent = 'Add and read the field';
            toast('Could not read the event: ' + (e.message || e), 'error');
        }
    };
    wrap.appendChild(input); wrap.appendChild(cat); wrap.appendChild(btn); wrap.appendChild(status);
    return wrap;
}

async function refreshEvent(ftEventId, onProgress, force = false) {
    let last = null;
    for (let i = 0; i < 8; i++) {
        const { data, error } = await supa.functions.invoke('refresh-event', { body: { ft_event_id: ftEventId, force: force && i === 0 } });
        if (error) throw new Error(error.message || 'refresh failed');
        if (data?.error) throw new Error(data.error);
        last = data;
        onProgress?.(data.cached ? `Cached: ${data.entrants} entrants, read ${new Date(data.last_refreshed_at).toLocaleDateString()}` : `${data.entrants} entrants · ${data.snapshots_fresh} scored${data.partial ? ' · reading more…' : ''}`);
        if (!data.partial) break;
    }
    return last;
}

// ---------------------------------------------------------------------------
// Cost for one adult and this fencer, for the days he fences at that
// tournament; and the marginal cost when his brother is going anyway. Priced
// from home when a home is set, else from the stored estimate. A live fare on
// a matching watch overrides either.
// ---------------------------------------------------------------------------
function tripCost(e, ctx) {
    const name = ctx.profile.name;
    // The days he fences there: this category, plus any other category at the
    // same tournament that is worth real points to him.
    const sameTrip = (x) => x.tournament === e.tournament && String(x.start_date).slice(0, 7) === String(e.start_date).slice(0, 7);
    const myDays = new Set(ctx.events
        .filter((x) => sameTrip(x) && (x.category === e.category || (x.projections?.[name]?.points_exp || 0) >= 8))
        .map((x) => String(x.start_date).slice(0, 10)));
    myDays.add(String(e.start_date).slice(0, 10));
    const dates = [...myDays].sort();
    const days = NATIONAL.has(e.tier) ? Math.max(2, (e.cost_breakdown?.days || 3)) : Math.max(1, Math.round((day(dates[dates.length - 1]) - day(dates[0])) / 864e5) + 1);
    let c = null;
    if (HOME && e.city) {
        const venue = PLACES.get(String(e.city).toLowerCase().replace(/\s+/g, ' ').trim());
        const est = venue ? estimateTrip({ home: HOME, venue, days, tier: e.tier }) : null;
        if (est) { c = withLiveFare({ ...est, live: false }, ctx.watches, ctx.latestPrice, e.city, e.start_date); e.travel = c.travel; }
    }
    if (!c) {
        const cb = e.cost_breakdown || {};
        if (!e.cost_breakdown && e.est_cost_two == null) return { total: 0, flight_pp: 0, nights: 0, hotel_night: 0, entries: 60, live: false, marginal: null };
        const nights = e.travel === 'local' ? 0 : e.travel === 'drive' ? days : days + 1;
        const base = { travel: e.travel, flight_pp: cb.flight_pp || 0, nights, hotel_night: cb.hotel_night ?? 160, entries: cb.entries ?? 60, drive: cb.drive ?? 0, live: false };
        base.total = base.flight_pp * 4 + nights * base.hotel_night + base.entries + base.drive;
        c = withLiveFare(base, ctx.watches, ctx.latestPrice, e.city, e.start_date);
    }
    // If the brother is going anyway, this fencer adds a fare (if flying) and his entry.
    c.marginal = (c.travel === 'fly' ? c.flight_pp * 2 : 0) + (c.entries || 60);
    // Per person: a return fare, half a room per night, the entry, half the driving.
    c.per_person = (c.travel === 'fly' ? c.flight_pp * 2 : 0) + (c.nights || 0) * (c.hotel_night || 0) / 2 + (c.entries || 60) + (c.drive || 0) / 2;
    return c;
}

function recentBouts(bouts, profile) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    wrap.appendChild(label('Recent bouts · from FencingTracker'));
    if (!bouts.length) { wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '6px 0 0' } }, ['No bouts loaded yet.'])); return wrap; }
    const off = profile.strength_de ?? 0;
    bouts.forEach((b, i) => {
        const win = b.result === 'V';
        const upset = win && b.opponent_strength > off + 40;
        const bad = !win && b.opponent_strength < off - 100;
        wrap.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '62px 1fr auto', gap: '8px', padding: '7px 0', borderTop: i ? '1px solid var(--rule)' : 'none', alignItems: 'baseline' } }, [
            el('span', { class: 'label', style: { color: INK_MUTE } }, [String(b.bout_date).slice(5)]),
            el('span', { style: { color: INK, fontSize: '14px', fontWeight: upset || bad ? '700' : '500' } }, [
                `${b.opponent} `, el('span', { class: 'label', style: { color: INK_MUTE } }, [`${b.opponent_strength ?? '—'} · ${catLabel(b.category)}`])
            ]),
            el('span', { class: 'num', style: { color: win ? GOOD : BAD, fontWeight: '700' } }, [`${win ? 'V' : 'D'} ${b.score_for}–${b.score_against}`])
        ]));
    });
    return wrap;
}
