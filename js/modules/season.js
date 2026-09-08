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
import { estimateTrip, withLiveFare } from '../lib/trip-cost.js';

const INK = 'var(--ink)';
// Literal: var(--ink-mute) composites below AA on the cream surface.
const INK_MUTE = '#6B7280';
const GOOD = '#1f7a1f';
const WARN = '#B45309';
const BAD = '#9b2230';

const CAT_ORDER = ['y12', 'y14', 'cadet', 'junior'];
const CAT_LABEL = { y12: 'Y12', y14: 'Y14', cadet: 'Cadet', junior: 'Junior' };
const TIER_LABEL = { ryc: 'RYC', syc: 'SYC', rjcc: 'RJCC', regional: 'Regional', sjcc: 'SJCC', nac: 'NAC', jo: 'Junior Olympics', nationals: 'Summer Nationals', other: 'Regional' };
const catLabel = (c) => CAT_LABEL[String(c || '').toLowerCase()] || String(c || '').toUpperCase();
const tierLabel = (t) => TIER_LABEL[String(t || '').toLowerCase()] || String(t || '').toUpperCase();
const NATIONAL = new Set(['nac', 'jo', 'nationals', 'sjcc']);

// The intentions, in the order a parent reads them.
const GROUPS = [
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
const day = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00');
const fmtDay = (iso) => day(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtRange = (a, b) => (!b || b === a) ? fmtDay(a)
    : fmtDay(a) + ' – ' + day(b).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const pct = (x) => x == null ? '—' : Math.round(x * 100) + '%';
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function stat(lbl, value, color = INK) {
    return el('div', { style: { minWidth: '76px' } }, [label(lbl), el('div', {}, [num(String(value ?? '—'), color, '18px')])]);
}

// Set once per mount: the family's home and the geocoded venue cities.
let HOME = null;
let PLACES = new Map();

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
    const body = el('div', {});
    root.appendChild(body);
    body.appendChild(el('div', { class: 'empty' }, [el('p', { class: 'empty-line' }, ['Reading the fields…'])]));

    const today = new Date().toISOString().slice(0, 10);
    const [tsRes, evRes, watchRes, priceRes, boutRes, refreshRes, mineRes, homeRes, runRes, sibRes] = await Promise.all([
        supa.from('true_strength').select('*').eq('profile_id', profile.id),
        supa.from('season_events').select('*').gte('start_date', today).order('start_date'),
        supa.from('flight_watches').select('id,label,destination,depart_date,return_date,hotel_nightly_rate,booked_out_cash,booked_ret_cash,passengers').is('deleted_at', null),
        supa.from('flight_prices').select('watch_id,price_per_person,effective_per_person,observed_at').order('observed_at', { ascending: false }).limit(200),
        supa.from('fencer_bouts').select('*').eq('profile_id', profile.id).order('bout_date', { ascending: false }).limit(40),
        supa.from('event_refresh').select('*'),
        supa.from('member_events').select('*').eq('profile_id', profile.id),
        supa.from('household').select('*').maybeSingle(),
        supa.from('refresh_runs').select('finished_at,events_done,pages').not('finished_at', 'is', null).order('id', { ascending: false }).limit(1).maybeSingle(),
        supa.from('profiles').select('id,name,birth_year,strength_de,strength_pool,tracker_id').eq('kind', 'fencer')
    ]);
    body.innerHTML = '';
    if (runRes?.data?.finished_at) {
        body.appendChild(el('div', { class: 'label', style: { color: INK_MUTE, padding: '0 var(--gut) 12px' } }, [
            `Fields last read ${new Date(runRes.data.finished_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · refreshed nightly`
        ]));
    }

    HOME = homeRes.data?.home_lat != null ? { lat: homeRes.data.home_lat, lng: homeRes.data.home_lng, city: homeRes.data.home_city, hotel_night: homeRes.data.hotel_night } : null;
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
    const sibling = siblings[0] || null;

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
    const ctx = { profile, sibling, ts90: ts[90], primary: primaryCategory(profile.birth_year), watches, latestPrice, events };
    for (const e of events) { e.cost = tripCost(e, ctx); e.group = classify(e, ctx); }

    body.appendChild(strengthCard(profile, ts, myForm));
    const chasing = CAT_ORDER.filter((c) => c !== 'junior' && events.some((e) => e.category === c));
    for (const cat of chasing) body.appendChild(pointsPlanCard(profile, cat, events.filter((e) => e.category === cat), ctx));
    for (const [key, title, sub] of GROUPS) {
        const rows = events.filter((e) => e.group === key);
        if (rows.length) body.appendChild(groupCard(key, title, sub, rows, ctx, refreshed));
    }
    body.appendChild(howToRead(profile, sibling));
    body.appendChild(addEventCard(profile));
    body.appendChild(recentBouts(boutRes.data || [], profile));
}

// ---------------------------------------------------------------------------
// Intention: which group an event belongs in for this fencer.
// ---------------------------------------------------------------------------
function classify(e, ctx) {
    const p = e.projections[ctx.profile.name] || {};
    if (p.pending) return 'anchor';
    const pts = p.points_exp || 0;
    const ppd = e.cost?.total > 0 ? pts / e.cost.total * 100 : null;
    const playingUp = ctx.primary && catRank(e.category) > catRank(ctx.primary);
    const formDown = ctx.ts90 && ctx.ts90.vs_weaker >= 6 && ctx.ts90.losses_vs_weaker / ctx.ts90.vs_weaker >= 0.3;
    const sibGoing = siblingGoing(e, ctx);

    if (NATIONAL.has(e.tier)) {
        // A national event is an anchor when it can fill a slot: his own
        // category, or a cadet national result that counts for Y14.
        if (!playingUp || e.category === 'cadet' && ctx.primary === 'y14') return pts >= 3 ? 'anchor' : 'skip';
        return sibGoing ? 'addon' : 'skip';
    }
    if (playingUp && formDown) return sibGoing && pts >= 8 ? 'addon' : 'skip';
    if (pts >= 20 && (ppd == null || ppd >= 3)) return 'value';
    if (pts >= 20) return sibGoing ? 'addon' : 'value';
    if (e.tier === 'ryc' && p.seed_form <= 3 && p.p8 >= 0.8) return 'confidence';
    if (sibGoing && pts >= 8) return 'addon';
    if (p.field_n >= 8 && p.seed_form <= Math.max(8, Math.ceil(p.field_n / 2)) && p.p16 >= 0.2 && !playingUp) return 'challenge';
    if (p.field_n >= 8 && p.seed_form <= Math.ceil(p.field_n / 2) && playingUp && !formDown) return 'challenge';
    return 'skip';
}

// Is the brother going to this tournament anyway? He is when he has an anchor
// there, or an event worth real points.
function siblingGoing(e, ctx) {
    if (!ctx.sibling) return false;
    return ctx.events.some((x) => x.tournament === e.tournament && String(x.start_date).slice(0, 7) === String(e.start_date).slice(0, 7)
        && (NATIONAL.has(x.tier) || (x.projections?.[ctx.sibling.name]?.points_exp || 0) >= 20));
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
    wrap.appendChild(label(`${catLabel(cat)} · points plan${playingUp ? ' · playing up' : ''}`));

    const slots = [];
    if (cat === 'y12' || cat === 'y14') {
        const syc = rows.filter((e) => e.tier === 'syc' && e.group !== 'skip').sort((a, b) => P(b) - P(a));
        const nat = rows.filter((e) => NATIONAL.has(e.tier) && e.group !== 'skip').sort((a, b) => P(b) - P(a));
        const cadetNat = cat === 'y14' ? ctx.events.filter((e) => e.category === 'cadet' && NATIONAL.has(e.tier) && e.group !== 'skip').sort((a, b) => P(b) - P(a)) : [];
        if (syc[0]) slots.push({ name: 'One SYC counts', ev: syc[0], alt: syc[1] });
        for (const e of nat.slice(0, 3)) slots.push({ name: e.tier === 'nationals' ? 'Summer Nationals' : 'NAC', ev: e });
        for (const e of cadetNat.slice(0, 2)) slots.push({ name: 'Cadet national result, counts for Y14', ev: e });
        const total = slots.map((s) => P(s.ev)).sort((a, b) => b - a).slice(0, 4).reduce((a, b) => a + b, 0);
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
            'Best six results count, and regional Cadet events (RJCC, RCC) count nationally this season: a top 8 is 36.6, top 16 is 31.2, anywhere in the top 64 is 22.2. A Challenger-bracket NAC top 64 is 31.8.'
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
        grid.appendChild(num(Math.round(P(s.ev)).toString(), P(s.ev) >= 30 ? GOOD : INK, '18px'));
    }
    wrap.appendChild(grid);
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
    if (p.pending) {
        row.appendChild(el('p', { style: { color: WARN, fontSize: '13px', margin: '2px 0 0' } }, ['Field not read yet.']));
    } else {
        const stats = [
            stat('Field', `${e.entrants ?? p.field_n ?? '—'}`),
            stat('Seed', `${p.seed_form}` + (p.seed_official && p.seed_official !== p.seed_form ? ` (${p.seed_official})` : ''), p.seed_form <= 8 ? GOOD : INK),
            ...(p.seed_pool ? [stat('By pools', `${p.seed_pool}`, p.seed_pool > p.seed_form + 4 ? WARN : INK)] : []),
            stat('Expected', ordinal(Math.round(p.median || p.exp)), finishColor),
            stat('Top 8', pct(p.p8), p.p8 >= 0.6 ? GOOD : INK),
            stat('Points', p.points_exp == null ? '—' : pts.toFixed(0), pts >= 25 ? GOOD : INK)
        ];
        if (group === 'addon' && cost.marginal != null) stats.push(stat('His cost', money(cost.marginal), GOOD));
        else stats.push(stat('Trip', cost.total > 0 ? money(cost.total) : '—', cost.live ? GOOD : INK));
        if (group === 'value' || group === 'anchor') stats.push(stat('Pts / $100', ppd == null ? '—' : ppd.toFixed(1), ppd >= 5 ? GOOD : INK));
        row.appendChild(el('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '2px' } }, stats));
    }
    const note = [];
    if (group === 'addon' && ctx.sibling) note.push(`${ctx.sibling.name} is going. ${e.travel === 'fly' ? `Add his fare, about ${money(cost.flight_pp * 2)} return,` : 'No extra travel,'} plus the entry.`);
    if (cost.live) note.push(`Fare is live from the Travel screen: ${money(cost.flight_pp)} per person each way.`);
    else if (e.travel === 'fly' && group !== 'addon') note.push(`Fare estimated at ${money(cost.flight_pp)} per person one way.`);
    if (cost.nights && group !== 'addon') note.push(`${cost.nights} night${cost.nights > 1 ? 's' : ''} at ${money(cost.hotel_night)}.`);
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
    if (e.ft_event_id && group !== 'skip') {
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
function strengthCard(profile, ts, myForm) {
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
    const rowsSpec = [
        ['Performance', (t) => t.performance_rating, (t) => t.perf_minus_official >= 60 ? GOOD : t.perf_minus_official <= -60 ? BAD : INK],
        ['vs official', (t) => (t.perf_minus_official > 0 ? '+' : '') + t.perf_minus_official, (t) => t.perf_minus_official >= 60 ? GOOD : t.perf_minus_official <= -60 ? BAD : INK],
        ['Record', (t) => `${t.wins}–${t.bouts - t.wins}`, () => INK],
        ['Beat stronger', (t) => `${t.wins_vs_stronger} of ${t.vs_stronger}`, (t) => t.wins_vs_stronger > 0 ? GOOD : INK],
        ['Lost to weaker', (t) => `${t.losses_vs_weaker} of ${t.vs_weaker}`, (t) => t.losses_vs_weaker > t.vs_weaker * 0.25 ? BAD : INK],
        ['Best win', (t) => t.best_win_strength ?? '—', () => GOOD],
        ['Worst loss', (t) => t.worst_loss_strength ?? '—', () => BAD],
        ['Bouts', (t) => t.bouts, () => INK]
    ];
    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(92px, 1.2fr) 1fr 1fr', columnGap: '12px', rowGap: '6px', alignItems: 'baseline' } });
    grid.appendChild(el('span', {}, ['']));
    grid.appendChild(label('Last 3 months', INK, { fontWeight: '700' }));
    grid.appendChild(label('Last 6 months', INK, { fontWeight: '700' }));
    const t90 = ts[90], t180 = ts[180];
    const cell = (t, get, col) => t && t.bouts ? num(String(get(t)), col(t), '18px') : el('span', { class: 'label', style: { color: INK_MUTE } }, ['—']);
    for (const [lbl, get, col] of rowsSpec) { grid.appendChild(label(lbl)); grid.appendChild(cell(t90, get, col)); grid.appendChild(cell(t180, get, col)); }
    wrap.appendChild(grid);
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

function howToRead(profile, sibling) {
    return el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } }, [
        label('How to read the plan'),
        el('p', { style: { color: INK, fontSize: '13px', margin: '6px 0 0', lineHeight: '1.55' } }, [
            el('b', {}, ['Field']), ' is who is registered. Events marked live were read on demand; the rest use the nightly snapshot. ',
            el('b', {}, ['Seed']), ' is his place in that field on form strength, official seed in brackets; ', el('b', {}, ['by pools']), ' is where his pool strength would draw him. ',
            el('b', {}, ['Expected']), ' is the median finish of a simulated bracket. ',
            el('b', {}, ['Points']), ' are national points for that finish under the 2026-27 tables, weighted by how likely each finish is. ',
            el('b', {}, ['Trip']), ` is fare for two, hotel nights and entries from ${HOME?.city || 'home'}; a live fare from the Travel screen replaces the estimate. `,
            sibling ? `Where ${sibling.name} is going anyway, ${profile.name}'s cost is shown as his fare and entry only. ` : '',
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
