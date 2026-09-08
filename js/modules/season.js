// Season plan — which events are worth the money, for each boy, in one place
// with the flights.
//
// The question a parent actually asks is not "how strong is he" but "if we
// spend the weekend and the fare, what do we get back". This screen answers
// it per event: the field that is really registered, where each boy seeds in
// it on his recent form, the finish the bracket simulation expects, the
// national points that finish is worth under the 2026-27 rules, and what the
// trip costs from Rowland Heights. Points per dollar is the ranking. A watched
// fare from the Travel screen replaces the estimate the moment one exists.
//
// Two sources feed the fields. The season table carries the 8 September
// snapshot for every event on the calendar. An event a member adds here is
// refreshed on demand through the refresh-event function - the entry list and
// each entrant's strength trend, read once and cached - and is then scored
// live in the browser (lib/season-model.js), opponents tilted by their own
// 90-day trend the same way the boys are seeded on theirs.

import { el, toast } from '../lib/util.js';
import { supa } from '../lib/supa.js';
import { activeProfile } from '../lib/state.js';
import { safeWrite } from '../lib/offline.js';
import { forecast, tierOf, categoryOf } from '../lib/season-model.js';
import { estimateTrip, withLiveFare } from '../lib/trip-cost.js';

// Set once per mount: the family's home and the geocoded venue cities, so a
// trip is priced from their door rather than from the stored estimate.
let HOME = null;
let PLACES = new Map();

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
    const [tsRes, evRes, watchRes, priceRes, boutRes, refreshRes, mineRes, homeRes, runRes] = await Promise.all([
        supa.from('true_strength').select('*').eq('profile_id', profile.id),
        supa.from('season_events').select('*').gte('start_date', today).order('start_date'),
        supa.from('flight_watches').select('id,label,destination,depart_date,return_date,hotel_nightly_rate,booked_out_cash,booked_ret_cash,passengers').is('deleted_at', null),
        supa.from('flight_prices').select('watch_id,price_per_person,effective_per_person,observed_at').order('observed_at', { ascending: false }).limit(200),
        supa.from('fencer_bouts').select('*').eq('profile_id', profile.id).order('bout_date', { ascending: false }).limit(40),
        supa.from('event_refresh').select('*'),
        supa.from('member_events').select('*').eq('profile_id', profile.id),
        supa.from('household').select('*').maybeSingle(),
        supa.from('refresh_runs').select('finished_at,events_done,pages').not('finished_at', 'is', null).order('id', { ascending: false }).limit(1).maybeSingle()
    ]);
    body.innerHTML = '';
    if (runRes?.data?.finished_at) {
        body.appendChild(el('div', { class: 'label', style: { color: INK_MUTE, padding: '0 var(--gut) 12px' } }, [
            `Fields last read ${new Date(runRes.data.finished_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · refreshed nightly`
        ]));
    }

    // Price from home when a home is set; venue cities come from the geocode cache.
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

    // Live forecasts for any event that has been refreshed on demand.
    await applyLiveForecasts(events, refreshed, profile, myForm);
    events = events.filter((e) => e.projections[profile.name]).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

    body.appendChild(strengthCard(profile, ts, myForm));
    body.appendChild(bestTrips(profile, events, watches, latestPrice));
    body.appendChild(howToRead());
    body.appendChild(addEventCard(profile));

    const cats = [...new Set(events.map((e) => e.category))].filter(Boolean)
        .sort((a, b) => CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b));
    for (const cat of cats) {
        body.appendChild(categoryPlan(profile, cat, events.filter((e) => e.category === cat), watches, latestPrice, refreshed));
    }
    if (!cats.length) {
        body.appendChild(el('div', { class: 'empty' }, [el('p', { class: 'empty-line' }, ['No upcoming events have been evaluated for this fencer yet. Add one below.'])]));
    }
    body.appendChild(recentBouts(boutRes.data || [], profile));
}

// ---------------------------------------------------------------------------
// Live scoring from the on-demand cache: entrants + each fencer's trend.
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
        const prev = e.projections[profile.name] || {};
        e.projections[profile.name] = { ...prev, ...f, pending: false };
        e.entrants = list.length;
        e.refreshed_at = refreshed.get(Number(e.ft_event_id))?.last_refreshed_at;
    }
}

// ---------------------------------------------------------------------------
// Strength: official, and what the last 90 / 180 days of bouts say.
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

    // The two windows side by side: the same columns, so the eye compares.
    const rowsSpec = [
        ['Performance', (t) => t.performance_rating, (t) => t.perf_minus_official >= 60 ? GOOD : t.perf_minus_official <= -60 ? BAD : INK],
        ['vs official', (t) => (t.perf_minus_official > 0 ? '+' : '') + t.perf_minus_official, (t) => t.perf_minus_official >= 60 ? GOOD : t.perf_minus_official <= -60 ? BAD : INK],
        ['Record', (t) => `${t.wins}–${t.bouts - t.wins}`, () => INK],
        ['Beat stronger', (t) => `${t.wins_vs_stronger} of ${t.vs_stronger}`, (t) => t.wins_vs_stronger > 0 ? GOOD : INK],
        ['Lost to weaker', (t) => `${t.losses_vs_weaker} of ${t.vs_weaker}`, (t) => t.losses_vs_weaker > t.vs_weaker * 0.25 ? BAD : INK],
        ['Best win', (t) => t.best_win_strength ?? '—', () => GOOD],
        ['Worst loss', (t) => t.worst_loss_strength ?? '—', () => BAD]
    ];
    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(92px, 1.2fr) 1fr 1fr', columnGap: '12px', rowGap: '6px', alignItems: 'baseline' } });
    grid.appendChild(el('span', {}, ['']));
    grid.appendChild(label('Last 3 months', INK, { fontWeight: '700' }));
    grid.appendChild(label('Last 6 months', INK, { fontWeight: '700' }));
    const t90 = ts[90], t180 = ts[180];
    const cell = (t, get, col) => t && t.bouts ? num(String(get(t)), col(t), '18px') : el('span', { class: 'label', style: { color: INK_MUTE } }, ['—']);
    for (const [lbl, get, col] of rowsSpec) {
        grid.appendChild(label(lbl));
        grid.appendChild(cell(t90, get, col));
        grid.appendChild(cell(t180, get, col));
    }
    grid.appendChild(label('Bouts'));
    grid.appendChild(cell(t90, (t) => t.bouts, () => INK));
    grid.appendChild(cell(t180, (t) => t.bouts, () => INK));
    wrap.appendChild(grid);

    // Pools decide the seed; the seed decides the bracket.
    if (de && pool) {
        const g = de - pool;
        wrap.appendChild(el('p', { style: { color: g >= 200 ? WARN : INK, fontSize: '13px', margin: '12px 0 0', lineHeight: '1.5', fontWeight: g >= 200 ? '700' : '500' } }, [
            g >= 200
                ? `Pools trail his DE by ${g} points. He is drawn into brackets as a weaker fencer than he is, and meets the top seeds a round early.`
                : g <= -100 ? `Pools run ${-g} ahead of his DE: he seeds well, then gives it back in the bracket. The work is in the 15-touch bout.`
                : 'Pools and DE are in step; his seed matches how he fences.'
        ]));
    }
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '10px 0 0', lineHeight: '1.5' } }, [
        'Performance is the strength that best explains his wins and losses against opponents of known strength, on the same scale FencingTracker uses. Every registered opponent below gets the same two windows from their own results.'
    ]));
    return wrap;
}

function howToRead() {
    return el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } }, [
        label('How to read the plan'),
        el('p', { style: { color: INK, fontSize: '13px', margin: '6px 0 0', lineHeight: '1.55' } }, [
            el('b', {}, ['Field']), ' is who is registered. Events marked live were read on demand and score every opponent on their own 90-day trend; the rest use the 8 September snapshot. ',
            el('b', {}, ['Seed']), ' is his place in that field on form strength, official seed in brackets. ',
            el('b', {}, ['Expected']), ' is the median finish of a simulated bracket. ',
            el('b', {}, ['Points']), ' are national points for that finish under the 2026-27 tables, weighted by how likely each finish is. ',
            el('b', {}, ['Trip']), ' is fare for two, hotel nights and entries from Rowland Heights; a live fare from the Travel screen replaces the estimate. ',
            'Cadet regionals count toward national points this season. Youth RYCs do not; only SYCs and NACs do, and only one SYC counts.'
        ])
    ]);
}

// ---------------------------------------------------------------------------
// Add an event: paste the FencingTracker event link. The entry list and each
// entrant's trend are read once, on demand, then scored here.
// ---------------------------------------------------------------------------
function addEventCard(profile) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    wrap.appendChild(label('Add an event'));
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '6px 0 10px', lineHeight: '1.5' } }, [
        'Paste the FencingTracker link of the event he is registered for (fencingtracker.com/event/…). The entry list is read once and every registered fencer is scored on their recent trend.'
    ]));
    const input = el('input', { type: 'text', class: 'field-input', placeholder: 'https://fencingtracker.com/event/12345', autocomplete: 'off' });
    const cat = el('select', { class: 'field-input', style: { marginTop: '8px' } }, [
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
            if (res?.title && !cat.value) {
                await safeWrite({ table: 'member_events', op: 'update', match: { profile_id: profile.id, ft_event_id: ftEventId }, payload: { category: categoryOf(res.title), tournament: res.title, event_date: res.event_date } });
            } else if (res?.title) {
                await safeWrite({ table: 'member_events', op: 'update', match: { profile_id: profile.id, ft_event_id: ftEventId }, payload: { tournament: res.title, event_date: res.event_date } });
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

// Calls the function until it reports the whole field is cached (it reads at
// most sixty pages per call, slowly, on purpose).
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
        if (!trips.has(key)) trips.set(key, { tournament: e.tournament, city: e.city, travel: e.travel, tier: e.tier, start: e.start_date, end: e.end_date, cost: tripCost(e, watches, latestPrice), pts: 0, parts: [], live: false });
        const t = trips.get(key);
        t.pts += p.points_exp;
        t.live = t.live || Boolean(p.live);
        t.start = t.start < e.start_date ? t.start : e.start_date;
        t.end = (t.end || '') > (e.end_date || '') ? t.end : e.end_date;
        t.parts.push(`${catLabel(e.category)} seed ${p.seed_form}, expected ${ordinal(p.median || Math.round(p.exp))}, ${p.points_exp.toFixed(0)} pts`);
    }
    const ranked = [...trips.values()].filter((t) => t.pts >= 8).sort((a, b) => b.pts / Math.max(1, b.cost.total) - a.pts / Math.max(1, a.cost.total));
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    wrap.appendChild(label('Best trips · points per dollar'));
    wrap.appendChild(serif(ranked.length ? `${ranked.length} weekends worth going` : 'No weekend clears the bar yet', '26px', ranked.length ? INK : WARN));
    ranked.slice(0, 12).forEach((t, i) => {
        const ppd = t.cost.total > 0 ? t.pts / t.cost.total * 100 : null;
        wrap.appendChild(el('div', { style: { padding: '10px 0', borderTop: i ? '1px solid var(--rule)' : 'none' } }, [
            el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' } }, [
                el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: i < 3 ? '700' : '600', fontSize: '19px', color: INK } }, [`${i + 1}. ${t.tournament}`]),
                el('span', { class: 'label', style: { color: INK_MUTE } }, [`${fmtRange(t.start, t.end)} · ${t.city || 'city not set'} · ${t.travel === 'local' ? 'drive, no hotel' : t.travel || ''}${t.live ? ' · live field' : ''}`])
            ]),
            el('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '4px' } }, [
                stat('Points', t.pts.toFixed(0), t.pts >= 60 ? GOOD : INK),
                stat('Trip', t.cost.total > 0 ? money(t.cost.total) : 'add on Travel', t.cost.live ? GOOD : INK),
                stat('Pts / $100', ppd == null ? '—' : ppd.toFixed(1), ppd >= 8 ? GOOD : INK)
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
function categoryPlan(profile, cat, rows, watches, latestPrice, refreshed) {
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    const boy = profile.name;
    const ranked = rows.map((e) => {
        const p = e.projections[boy];
        const cost = tripCost(e, watches, latestPrice);
        const ppd = cost.total > 0 && p.points_exp != null ? p.points_exp / cost.total * 100 : null;
        return { e, p, cost, ppd };
    }).sort((a, b) => (b.ppd ?? (b.p.points_exp != null ? 0 : -1)) - (a.ppd ?? (a.p.points_exp != null ? 0 : -1)));

    wrap.appendChild(label(`${catLabel(cat)} · ${ranked.length} events evaluated`));
    const worth = ranked.filter((r) => (r.p.points_exp || 0) >= 8);
    wrap.appendChild(serif(worth.length ? `${worth.length} worth the trip` : 'Nothing worth the trip yet', '26px', worth.length ? INK : WARN));

    const list = el('div', { style: { marginTop: '10px' } });
    ranked.forEach((r, i) => list.appendChild(eventRow(r, i, profile, refreshed)));
    wrap.appendChild(list);
    return wrap;
}

function eventRow({ e, p, cost, ppd }, i, profile, refreshed) {
    const finishColor = p.p8 >= 0.6 ? GOOD : p.p16 >= 0.5 ? INK : WARN;
    const top = i < 3 && (p.points_exp || 0) >= 8;
    const row = el('div', { style: {
        padding: '12px 0', borderTop: i === 0 ? 'none' : '1px solid var(--rule)',
        display: 'grid', gridTemplateColumns: '1fr', gap: '6px'
    } });
    row.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } }, [
        el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: top ? '700' : '600', fontSize: '19px', color: INK } }, [e.tournament]),
        el('span', { class: 'label', style: { color: INK_MUTE } }, [`${tierLabel(e.tier)} · ${fmtRange(e.start_date, e.end_date)}${p.live ? ' · live' : ''}`])
    ]));
    const travelWord = e.travel === 'local' ? 'drive, no hotel' : e.travel === 'drive' ? 'drive' : e.travel === 'fly' ? 'fly' : '';
    row.appendChild(el('div', { class: 'label', style: { color: INK_MUTE } }, [
        [e.city, e.venue, travelWord].filter(Boolean).join(' · ') || 'City not set'
    ]));
    if (p.pending) {
        row.appendChild(el('p', { style: { color: WARN, fontSize: '13px', margin: '2px 0 0' } }, ['Field not read yet.']));
    } else {
        row.appendChild(el('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '2px' } }, [
            stat('Field', `${e.entrants ?? p.field_n ?? '—'}`),
            stat('Seed', `${p.seed_form}` + (p.seed_official && p.seed_official !== p.seed_form ? ` (${p.seed_official})` : ''), p.seed_form <= 8 ? GOOD : INK),
            ...(p.seed_pool ? [stat('By pools', `${p.seed_pool}`, p.seed_pool > p.seed_form + 4 ? WARN : INK)] : []),
            stat('Expected', ordinal(Math.round(p.median || p.exp)), finishColor),
            stat('Top 8', pct(p.p8), p.p8 >= 0.6 ? GOOD : INK),
            stat('Top 16', pct(p.p16)),
            stat('Points', p.points_exp == null ? '—' : p.points_exp.toFixed(1), (p.points_exp || 0) >= 25 ? GOOD : INK),
            stat('Trip', cost.total > 0 ? money(cost.total) : '—', cost.live ? GOOD : INK),
            stat('Pts / $100', ppd == null ? '—' : ppd.toFixed(1), ppd >= 5 ? GOOD : INK)
        ]));
    }
    const note = [];
    if (cost.live) note.push(`Fare is live from the Travel screen: ${money(cost.flight_pp)} per person each way.`);
    else if (e.travel === 'fly') note.push(`Fare estimated at ${money(cost.flight_pp)} per person one way. Add a watch on Travel to price it.`);
    if (cost.nights) note.push(`${cost.nights} hotel night${cost.nights > 1 ? 's' : ''} at ${money(cost.hotel_night)}.`);
    if (p.live && p.trend) {
        const bits = Object.entries(p.trend).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
        if (bits.length) note.push(`Registered field on their 90-day trend: ${bits.join(', ')}. Read ${e.refreshed_at ? new Date(e.refreshed_at).toLocaleDateString() : 'recently'}.`);
    } else if (e.plan_note) note.push(e.plan_note);
    if (note.length) row.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '2px 0 0', lineHeight: '1.5' } }, [note.join(' ')]));

    // The fencers just above his seed, each with their own last 3 and 6 months.
    if (p.live && p.neighbours?.length) {
        row.appendChild(label('Around his seed · their recent form', INK_MUTE, { marginTop: '6px' }));
        row.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr', gap: '4px', marginTop: '2px' } }, p.neighbours.map((n) => {
            const col = n.tag === 'rising' ? WARN : n.tag === 'fading' || n.tag === 'inactive' ? GOOD : INK;
            return el('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } }, [
                el('a', { href: `https://fencingtracker.com/p/${n.tracker_id}/x`, target: '_blank', rel: 'noopener',
                    style: { color: INK, fontSize: '14px', fontWeight: n.tag === 'rising' ? '700' : '500', textDecoration: 'none' } }, [n.name]),
                el('span', { class: 'num', style: { color: INK, fontSize: '13px' } }, [String(n.strength)]),
                n.tag !== 'steady' ? el('span', { class: 'label', style: { color: col, fontWeight: '700' } }, [n.tag]) : null,
                el('span', { class: 'label', style: { color: INK_MUTE } }, [n.form || ''])
            ].filter(Boolean));
        })));
    }

    // On-demand refresh for any event FencingTracker lists.
    if (e.ft_event_id) {
        const rb = el('button', { class: 'btn btn-ghost btn-sm btn-mono-label', style: { marginTop: '6px', justifySelf: 'start' } }, [refreshed.has(Number(e.ft_event_id)) ? 'Re-read the field' : 'Read the live field']);
        rb.onclick = async () => {
            rb.disabled = true; rb.textContent = 'Reading…';
            try {
                await refreshEvent(Number(e.ft_event_id), (msg) => { rb.textContent = msg; }, refreshed.has(Number(e.ft_event_id)));
                location.reload();
            } catch (err) { rb.disabled = false; rb.textContent = 'Read the live field'; toast('Could not read: ' + (err.message || err), 'error'); }
        };
        row.appendChild(rb);
    }
    return row;
}

// Cost for one adult and one fencer. Priced from the family's home when one is
// set (drive or fly by distance, flat hotel estimate), else from the stored
// estimate. A live fare (latest observed price on a watch to the same city
// within four days of the event) overrides either.
function tripCost(e, watches, latestPrice) {
    if (HOME && e.city) {
        const venue = PLACES.get(String(e.city).toLowerCase().replace(/\s+/g, ' ').trim());
        const days = (e.cost_breakdown && e.cost_breakdown.days) || 1;
        const est = venue ? estimateTrip({ home: HOME, venue, days, tier: e.tier }) : null;
        if (est) {
            const c = withLiveFare({ ...est, live: false }, watches, latestPrice, e.city, e.start_date);
            e.travel = c.travel;   // so the row says drive or fly from this home, not from the stored one
            return c;
        }
    }
    const cb = e.cost_breakdown || {};
    if (!e.cost_breakdown && e.est_cost_two == null) return { total: 0, flight_pp: 0, nights: 0, hotel_night: 0, entries: 0, live: false };
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
