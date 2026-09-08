// Season plan — which events are worth the money, for each boy, in one place
// with the flights.
//
// The question a parent actually asks is not "how strong is he" but "if we
// spend the weekend and the fare, what do we get back". This screen answers
// it per event: the field that is really registered (FencingTracker, live),
// where each boy seeds in it on his recent form, the finish the bracket
// simulation expects, the national points that finish is worth under the
// 2026-27 rules, and what the trip costs from Rowland Heights. Points per
// dollar is the ranking. A watched fare from the Travel screen replaces the
// estimate the moment one exists.
//
// Form strength comes from the last 90 and 180 days of bouts, opponent by
// opponent, not from the all-time number FencingTracker seeds with.

import { el } from '../lib/util.js';
import { supa } from '../lib/supa.js';
import { activeProfile } from '../lib/state.js';

const INK = 'var(--ink)';
// Literal: var(--ink-mute) composites below AA on the cream surface.
const INK_MUTE = '#6B7280';
const GOOD = '#1f7a1f';
const WARN = '#B45309';
const BAD = '#9b2230';

const CAT_ORDER = ['y12', 'y14', 'cadet', 'junior'];
const CAT_LABEL = { y12: 'Y12', y14: 'Y14', cadet: 'Cadet', junior: 'Junior' };
const TIER_LABEL = { ryc: 'RYC', syc: 'SYC', rjcc: 'RJCC', sjcc: 'SJCC', nac: 'NAC', jo: 'Junior Olympics', nationals: 'Summer Nationals', other: 'Regional' };
const catLabel = (c) => CAT_LABEL[String(c || '').toLowerCase()] || String(c || '').toUpperCase();
const tierLabel = (t) => TIER_LABEL[String(t || '').toLowerCase()] || String(t || '').toUpperCase();

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
    return el('div', { style: { minWidth: '84px' } }, [label(lbl), el('div', {}, [num(String(value ?? '—'), color)])]);
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
    const [tsRes, evRes, watchRes, priceRes, boutRes] = await Promise.all([
        supa.from('true_strength').select('*').eq('profile_id', profile.id),
        supa.from('season_events').select('*').gte('start_date', today).order('start_date'),
        supa.from('flight_watches').select('id,label,destination,depart_date,return_date,hotel_nightly_rate,booked_out_cash,booked_ret_cash,passengers').is('deleted_at', null),
        supa.from('flight_prices').select('watch_id,price_per_person,effective_per_person,observed_at').order('observed_at', { ascending: false }).limit(200),
        supa.from('fencer_bouts').select('*').eq('profile_id', profile.id).order('bout_date', { ascending: false }).limit(40)
    ]);
    body.innerHTML = '';

    const ts = Object.fromEntries((tsRes.data || []).map((r) => [r.days, r]));
    const events = (evRes.data || []).filter((e) => e.projections && e.projections[profile.name]);
    const watches = watchRes.data || [];
    const latestPrice = {};
    for (const p of priceRes.data || []) if (!latestPrice[p.watch_id]) latestPrice[p.watch_id] = p;

    body.appendChild(strengthCard(profile, ts));
    body.appendChild(bestTrips(profile, events, watches, latestPrice));
    body.appendChild(howToRead());

    const cats = [...new Set(events.map((e) => e.category))]
        .sort((a, b) => CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b));
    for (const cat of cats) {
        body.appendChild(categoryPlan(profile, cat, events.filter((e) => e.category === cat), watches, latestPrice));
    }
    if (!cats.length) {
        body.appendChild(el('div', { class: 'empty' }, [el('p', { class: 'empty-line' }, ['No upcoming events have been evaluated for this fencer yet.'])]));
    }
    body.appendChild(recentBouts(boutRes.data || [], profile));
}

// ---------------------------------------------------------------------------
// Strength: official, and what the last 90 / 180 days of bouts say.
// ---------------------------------------------------------------------------
function strengthCard(profile, ts) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    wrap.appendChild(label('Strength · official vs form'));
    wrap.appendChild(serif(`${profile.strength_de ?? '—'} official`, '30px'));
    const rowFor = (t, name) => {
        if (!t || !t.bouts) return el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '6px 0 0' } }, [`No bouts in the last ${name}.`]);
        const gap = t.perf_minus_official;
        const gapColor = gap >= 60 ? GOOD : gap <= -60 ? BAD : INK;
        return el('div', { style: { margin: '12px 0 0' } }, [
            label(`Last ${name} · ${t.bouts} bouts`),
            el('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap', marginTop: '4px' } }, [
                stat('Performance', t.performance_rating, gapColor),
                stat('vs official', (gap > 0 ? '+' : '') + gap, gapColor),
                stat('Record', `${t.wins}–${t.bouts - t.wins}`),
                stat('vs stronger', `${t.wins_vs_stronger}–${t.vs_stronger - t.wins_vs_stronger}`, t.wins_vs_stronger > 0 ? GOOD : INK),
                stat('Lost to weaker', `${t.losses_vs_weaker} of ${t.vs_weaker}`, t.losses_vs_weaker > t.vs_weaker * 0.25 ? BAD : INK),
                stat('Best win', t.best_win_strength ?? '—', GOOD),
                stat('Worst loss', t.worst_loss_strength ?? '—', BAD)
            ])
        ]);
    };
    wrap.appendChild(rowFor(ts[90], '90 days'));
    wrap.appendChild(rowFor(ts[180], '180 days'));
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '12px 0 0', lineHeight: '1.5' } }, [
        'Performance is the strength that best explains these wins and losses against opponents of known strength, on the same scale FencingTracker uses. ',
        'A positive gap means he is fencing above his seeding. The plan below seeds him on form and shows the official seed in brackets.'
    ]));
    return wrap;
}

function howToRead() {
    return el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } }, [
        label('How to read the plan'),
        el('p', { style: { color: INK, fontSize: '13px', margin: '6px 0 0', lineHeight: '1.55' } }, [
            el('b', {}, ['Field']), ' is who is registered right now on FencingTracker. ',
            el('b', {}, ['Seed']), ' is his place in that field on form strength, official seed in brackets. ',
            el('b', {}, ['Expected']), ' is the median finish of a simulated bracket. ',
            el('b', {}, ['Points']), ' are national points for that finish under the 2026-27 tables, weighted by how likely each finish is. ',
            el('b', {}, ['Trip']), ' is fare for two, hotel nights and entries from Rowland Heights; a live fare from the Travel screen replaces the estimate. ',
            'Cadet regionals count toward national points this season. Youth RYCs do not; only SYCs and NACs do, and only one SYC counts.'
        ])
    ]);
}

// ---------------------------------------------------------------------------
// Trips, not events. A weekend usually has two of his categories at the same
// venue, and a trip is paid for once, so the ranking that matters sums the
// points of everything he can fence there against one fare and one hotel.
// ---------------------------------------------------------------------------
function bestTrips(profile, events, watches, latestPrice) {
    const boy = profile.name;
    const trips = new Map();
    for (const e of events) {
        const p = e.projections[boy];
        if (!p || p.points_exp == null) continue;
        const key = e.tournament + '|' + String(e.start_date).slice(0, 7);
        if (!trips.has(key)) trips.set(key, { tournament: e.tournament, city: e.city, travel: e.travel, tier: e.tier, start: e.start_date, end: e.end_date, cost: tripCost(e, watches, latestPrice), pts: 0, parts: [] });
        const t = trips.get(key);
        t.pts += p.points_exp;
        t.start = t.start < e.start_date ? t.start : e.start_date;
        t.end = (t.end || '') > (e.end_date || '') ? t.end : e.end_date;
        t.parts.push(`${catLabel(e.category)} seed ${p.seed_form}, expected ${ordinal(p.median || Math.round(p.exp))}, ${p.points_exp.toFixed(0)} pts`);
    }
    const ranked = [...trips.values()].filter((t) => t.pts >= 8).sort((a, b) => b.pts / Math.max(1, b.cost.total) - a.pts / Math.max(1, a.cost.total));
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    wrap.appendChild(label('Best trips · points per dollar'));
    wrap.appendChild(serif(ranked.length ? `${ranked.length} weekends worth going` : 'No weekend clears the bar yet', '26px', ranked.length ? INK : WARN));
    ranked.slice(0, 12).forEach((t, i) => {
        const ppd = t.pts / Math.max(1, t.cost.total) * 100;
        wrap.appendChild(el('div', { style: { padding: '10px 0', borderTop: i ? '1px solid var(--rule)' : 'none' } }, [
            el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' } }, [
                el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: i < 3 ? '700' : '600', fontSize: '19px', color: INK } }, [`${i + 1}. ${t.tournament}`]),
                el('span', { class: 'label', style: { color: INK_MUTE } }, [`${fmtRange(t.start, t.end)} · ${t.city || '—'} · ${t.travel === 'local' ? 'drive, no hotel' : t.travel || ''}`])
            ]),
            el('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '4px' } }, [
                stat('Points', t.pts.toFixed(0), t.pts >= 60 ? GOOD : INK),
                stat('Trip', money(t.cost.total), t.cost.live ? GOOD : INK),
                stat('Pts / $100', ppd.toFixed(1), ppd >= 8 ? GOOD : INK)
            ]),
            el('div', { style: { color: INK_MUTE, fontSize: '12px', marginTop: '4px', lineHeight: '1.5' } }, [t.parts.join(' · ')])
        ]));
    });
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '10px 0 0', lineHeight: '1.5' } }, [
        'Trip cost is one adult and this fencer. When his brother fences the same weekend, the fare for the adult and the hotel are shared, so a trip that is marginal for one boy can be clearly worth it for two.'
    ]));
    return wrap;
}

// ---------------------------------------------------------------------------
// One category: the events ranked by points per dollar, with the reasoning.
// ---------------------------------------------------------------------------
function categoryPlan(profile, cat, rows, watches, latestPrice) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    const boy = profile.name;
    const ranked = rows.map((e) => {
        const p = e.projections[boy];
        const cost = tripCost(e, watches, latestPrice);
        const ppd = cost.total > 0 ? (p.points_exp || 0) / cost.total * 100 : null;
        return { e, p, cost, ppd };
    }).sort((a, b) => (b.ppd ?? -1) - (a.ppd ?? -1));

    wrap.appendChild(label(`${catLabel(cat)} · ${ranked.length} events evaluated`));
    const worth = ranked.filter((r) => (r.p.points_exp || 0) >= 8);
    wrap.appendChild(serif(worth.length ? `${worth.length} worth the trip` : 'Nothing worth the trip yet', '26px', worth.length ? INK : WARN));

    const list = el('div', { style: { marginTop: '10px' } });
    ranked.forEach((r, i) => list.appendChild(eventRow(r, i)));
    wrap.appendChild(list);
    return wrap;
}

function eventRow({ e, p, cost, ppd }, i) {
    const finishColor = p.p8 >= 0.6 ? GOOD : p.p16 >= 0.5 ? INK : WARN;
    const top = i < 3 && (p.points_exp || 0) >= 8;
    const row = el('div', { style: {
        padding: '12px 0', borderTop: i === 0 ? 'none' : '1px solid var(--rule)',
        display: 'grid', gridTemplateColumns: '1fr', gap: '6px'
    } });
    row.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } }, [
        el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: top ? '700' : '600', fontSize: '19px', color: INK } }, [e.tournament]),
        el('span', { class: 'label', style: { color: INK_MUTE } }, [`${tierLabel(e.tier)} · ${fmtRange(e.start_date, e.end_date)}`])
    ]));
    const travelWord = e.travel === 'local' ? 'drive, no hotel' : e.travel === 'drive' ? 'drive' : e.travel === 'fly' ? 'fly' : '';
    row.appendChild(el('div', { class: 'label', style: { color: INK_MUTE } }, [
        [e.city, e.venue, travelWord].filter(Boolean).join(' · ')
    ]));
    row.appendChild(el('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '2px' } }, [
        stat('Field', `${e.entrants ?? p.field_n ?? '—'}`),
        stat('Seed', `${p.seed_form}` + (p.seed_official && p.seed_official !== p.seed_form ? ` (${p.seed_official})` : ''), p.seed_form <= 8 ? GOOD : INK),
        stat('Expected', ordinal(Math.round(p.exp)), finishColor),
        stat('Top 8', pct(p.p8), p.p8 >= 0.6 ? GOOD : INK),
        stat('Top 16', pct(p.p16)),
        stat('Points', (p.points_exp || 0).toFixed(1), (p.points_exp || 0) >= 25 ? GOOD : INK),
        stat('Trip', money(cost.total), cost.live ? GOOD : INK),
        stat('Pts / $100', ppd == null ? '—' : ppd.toFixed(1), ppd >= 5 ? GOOD : INK)
    ]));
    const note = [];
    if (cost.live) note.push(`Fare is live from the Travel screen: ${money(cost.flight_pp)} per person each way.`);
    else if (e.travel === 'fly') note.push(`Fare estimated at ${money(cost.flight_pp)} per person one way. Add a watch on Travel to price it.`);
    if (cost.nights) note.push(`${cost.nights} hotel night${cost.nights > 1 ? 's' : ''} at ${money(cost.hotel_night)}.`);
    if (e.plan_note) note.push(e.plan_note);
    if (note.length) row.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '2px 0 0', lineHeight: '1.5' } }, [note.join(' ')]));
    return row;
}

// Cost for one adult and one fencer. A live fare (latest observed price on a
// watch to the same city within four days of the event) overrides the estimate.
function tripCost(e, watches, latestPrice) {
    const cb = e.cost_breakdown || {};
    let flight_pp = cb.flight_pp || 0, live = false;
    const city = String(e.city || '').toLowerCase().split(',')[0].trim();
    const w = city ? watches.find((x) => {
        const near = Math.abs((day(x.depart_date) - day(e.start_date)) / 864e5) <= 4;
        return near && String(x.label || '').toLowerCase().includes(city);
    }) : null;
    if (w) {
        const lp = latestPrice[w.id];
        const pp = lp?.effective_per_person ?? lp?.price_per_person;
        if (pp) { flight_pp = pp / 2; live = true; }   // watches price round trips per person
        if (w.booked_out_cash) { flight_pp = (Number(w.booked_out_cash) + Number(w.booked_ret_cash || 0)) / 2; live = true; }
    }
    const pax = 2;
    const nights = cb.nights ?? 0, hotel_night = cb.hotel_night ?? 160;
    const entries = cb.entries ?? 60, drive = cb.drive ?? 0;
    const total = flight_pp * 2 * pax + nights * hotel_night + entries + drive;
    return { total, flight_pp, nights, hotel_night, entries, live };
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
