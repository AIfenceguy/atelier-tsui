// Season model — the scoring that turns a field into a forecast, in the browser.
//
// Same maths as the season scripts: each registered opponent is taken at their
// FencingTracker strength tilted by their own 90-day trend; the fencer is
// seeded on form; a single-elimination bracket with standard seeding is played
// out a couple of thousand times with a logistic win chance on a 400-point
// scale; the finish distribution is priced with the 2026-27 points tables.
// Everything here is deterministic given the inputs except the simulation,
// which is seeded so the same field gives the same forecast twice.

// ---- points tables --------------------------------------------------------
// Athlete Handbook domestic table (youth, unchanged for 2026-27).
function youthTable(cat) {
    const t = {};
    if (cat === 'y14') {
        Object.assign(t, { 1: 200, 2: 184, 3: 170, 4: 170, 5: 140, 6: 139, 7: 138, 8: 137 });
        for (let p = 9; p <= 16; p++) t[p] = 107 - (p - 9);
        for (let p = 17; p <= 32; p++) t[p] = 70 - (p - 17);
        for (let p = 33; p <= 64; p++) t[p] = 25 - 0.25 * (p - 33);
    } else if (cat === 'y12') {
        Object.assign(t, { 1: 150, 2: 138, 3: 127.5, 4: 127.5, 5: 105, 6: 104.25, 7: 103.5, 8: 102.75 });
        for (let p = 9; p <= 16; p++) t[p] = 80.25 - 0.75 * (p - 9);
        for (let p = 17; p <= 32; p++) t[p] = 52.5 - 0.75 * (p - 17);
        for (let p = 33; p <= 64; p++) t[p] = 18.375 - 0.1875 * (p - 33);
    }
    return t;
}
// 2026-27 Trial tables (USA Fencing, 29 Jul 2026): Division I and Senior
// values; Junior is 80% of them, Cadet 60%. Bands 1, 2, 4, 8, 16, 32, 64,
// 128, 256, 512. Same numbers as trial_points() in the database.
const BANDS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
const DIV1 = {
    elite: [1000, 690, 469, 314, 207, 135, 86, 54, 33, 20],
    challenger: [200, 160, 128, 102, 82, 66, 53, 42, 34, 27],
    sjcc: [150, 122.5, 100, 82.5, 67.5, 55, 45, 37.5, 30, 25],
    regional: [100, 85, 72, 61, 52, 44, 37, 31, 26, 22],
    local: [50, 45, 41, 37, 33, 30, 27, 24, 22, 20]
};
const FACTOR = { div1: 1, senior: 1, junior: 0.8, cadet: 0.6 };
function trialPoints(group, tier, place) {
    const v = DIV1[tier], f = FACTOR[group];
    if (!v || !f) return 0;
    const i = BANDS.findIndex((b) => place <= b);
    return i < 0 ? 0 : +(v[i] * f).toFixed(1);
}

export function pointsFor(category, tier, place, fieldSize) {
    const cat = String(category || '').toLowerCase();
    const t = String(tier || '').toLowerCase();
    if (cat === 'y12' || cat === 'y14') {
        const table = youthTable(cat);
        if (t === 'nac' || t === 'nationals') return (place > 32 && fieldSize < 160) ? 0 : (table[place] || 0);
        if (t === 'syc') {
            const cap = Math.min(64, Math.ceil(fieldSize * 0.4));
            return place <= cap ? 0.8 * (table[place] || 0) : 0;
        }
        return 0; // RYC: regional points only
    }
    if (cat === 'cadet' || cat === 'junior' || cat === 'div1') {
        // NAC entries are scored on the Challenger table unless told 'elite';
        // Junior Olympics and Nationals pay the Elite table in the Elite bracket.
        const key = t === 'nac' || t === 'jo' || t === 'nationals' ? 'challenger' : (t === 'sjcc' ? 'sjcc' : t === 'elite' ? 'elite' : t === 'local' ? 'local' : 'regional');
        if (key === 'sjcc' && place > Math.min(64, Math.ceil(fieldSize * 0.4))) return 0;
        return trialPoints(cat, key, place);
    }
    return 0;
}

// ---- opponents ------------------------------------------------------------
// A fencer_snapshot row → the strength to seed them at, and a trend tag.
export function tiltedStrength(snap, listedStrength) {
    const base = snap?.strength_de ?? listedStrength ?? null;
    if (base == null) return { strength: null, tag: 'unknown' };
    if (!snap || snap.de_90d == null) return { strength: base, tag: 'steady' };
    if ((snap.events_180d ?? 0) === 0 && !(snap.results_180d > 0)) return { strength: base - 50, tag: 'inactive' };
    // 1. The DE strength trend over 90 days, read as the visible edge of a larger move.
    const move = (snap.events_90d ?? 0) >= 2 ? snap.de_now - snap.de_90d : 0;
    let adj = Math.max(-200, Math.min(200, 2 * move));
    // 2. What they actually placed, last 3 months: a median in the top quarter of
    //    their fields is a fencer seeding below their level; bottom 40% the reverse.
    const med = snap.median_pct_90d ?? snap.median_pct_180d;
    const n = snap.results_90d ?? snap.results_180d ?? 0;
    if (med != null && n >= 2) {
        if (med <= 0.25) adj += 40;
        else if (med >= 0.6) adj -= 40;
    }
    // 3. Pools: a fencer whose pool strength trails their DE by 250+ gets a worse
    //    seed than their DE number says, and meets the top seeds earlier.
    if (snap.pool_now != null && snap.de_now != null && snap.de_now - snap.pool_now >= 250) adj -= 30;
    adj = Math.max(-250, Math.min(250, adj));
    const tag = move >= 40 || (med != null && med <= 0.2 && n >= 3) ? 'rising'
        : move <= -40 || (med != null && med >= 0.65 && n >= 3) ? 'fading' : 'steady';
    return { strength: base + adj, tag };
}

// A short, parent-readable line about a registered fencer's recent form.
export function formLine(snap) {
    if (!snap) return 'no recent record';
    const bits = [];
    if (snap.results_90d) bits.push(`${snap.results_90d} event${snap.results_90d > 1 ? 's' : ''} in 3 mo, median top ${Math.round((snap.median_pct_90d || 0) * 100)}%`);
    else if (snap.results_180d) bits.push(`${snap.results_180d} event${snap.results_180d > 1 ? 's' : ''} in 6 mo, median top ${Math.round((snap.median_pct_180d || 0) * 100)}%`);
    else bits.push('no events in 6 months');
    if (snap.de_90d != null && snap.de_now != null && Math.abs(snap.de_now - snap.de_90d) >= 20) bits.push(`DE ${snap.de_now - snap.de_90d > 0 ? '+' : ''}${snap.de_now - snap.de_90d} in 3 mo`);
    if (snap.pool_now != null && snap.de_now != null && snap.de_now - snap.pool_now >= 250) bits.push('weak pools');
    return bits.join(' · ');
}

// ---- bracket simulation ---------------------------------------------------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pwin = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));

export function simulate(fieldStrengths, me, sims = 1500, seed = 7) {
    const all = [...fieldStrengths, me].sort((a, b) => b - a);
    const n = all.length;
    let size = 1; while (size < n) size <<= 1;
    let order = [0];
    while (order.length < size) { const m = order.length * 2 - 1; order = order.flatMap((o) => [o, m - o]); }
    const meIdx = all.indexOf(me);
    const dist = new Array(n + 1).fill(0);
    const rnd = mulberry32(seed);
    for (let s = 0; s < sims; s++) {
        let slots = order.map((o) => (o < n ? o : null));
        let round = size, place = null;
        while (round > 1) {
            const next = [];
            for (let i = 0; i < slots.length; i += 2) {
                const a = slots[i], b = slots[i + 1];
                if (a == null) { next.push(b); continue; }
                if (b == null) { next.push(a); continue; }
                const w = rnd() < pwin(all[a], all[b]) ? a : b;
                const l = w === a ? b : a;
                if (l === meIdx && place == null) place = round / 2 + 1;
                next.push(w);
            }
            slots = next; round /= 2;
        }
        dist[Math.min(place || 1, n)] += 1;
    }
    return dist.map((d) => d / sims);
}

// ---- forecast for one fencer in one event ---------------------------------
// entrants: [{ tracker_id, name, strength_de }], snapshots: Map(tracker_id -> fencer_snapshot)
export function forecast({ entrants, snapshots, myStrength, myOfficial, myPool, myTrackerId, category, tier }) {
    const tagged = [];
    for (const e of entrants) {
        if (myTrackerId && Number(e.tracker_id) === Number(myTrackerId)) continue;
        const snap = snapshots?.get(Number(e.tracker_id));
        const { strength, tag } = tiltedStrength(snap, e.strength_de);
        if (strength != null && strength > 800 && strength < 3200) tagged.push({ ...e, strength, tag, snap });
    }
    // Where he would sit if the pools went by pool strength: the seed the
    // bracket is actually drawn from, which is why the pool gap matters.
    const poolOf = (x) => x.snap?.pool_now ?? x.snap?.strength_pool ?? null;
    const seed_pool = myPool != null ? 1 + tagged.filter((x) => (poolOf(x) ?? x.strength) > myPool).length : null;
    const field = tagged.map((x) => x.strength);
    if (field.length < 3) return null;
    const dist = simulate(field, myStrength);
    const n = field.length + 1;
    const cum = (k) => dist.slice(1, k + 1).reduce((a, b) => a + b, 0);
    let exp = 0, pts = 0, ptsElite = 0, median = null;
    const cadetNac = String(category).toLowerCase() === 'cadet' && String(tier).toLowerCase() === 'nac';
    for (let p = 1; p <= n; p++) {
        exp += p * dist[p];
        pts += dist[p] * pointsFor(category, tier, p, n);
        if (cadetNac) ptsElite += dist[p] * pointsFor(category, 'elite', p, n);
        if (median == null && cum(p) >= 0.5) median = p;
    }
    const trend = { rising: 0, fading: 0, inactive: 0 };
    for (const x of tagged) if (trend[x.tag] != null) trend[x.tag] += 1;
    return {
        field_n: n, registered: entrants.length,
        seed_form: 1 + field.filter((s) => s > myStrength).length,
        seed_official: 1 + field.filter((s) => s > myOfficial).length,
        seed_pool,
        p4: +cum(4).toFixed(2), p8: +cum(8).toFixed(2), p16: +cum(16).toFixed(2), p32: +cum(32).toFixed(2), p64: +cum(64).toFixed(2),
        exp: +exp.toFixed(1), median, points_exp: +pts.toFixed(1),
        ...(cadetNac ? { points_exp_if_elite: +ptsElite.toFixed(1) } : {}),
        points_if_top8: pointsFor(category, tier, 8, n), points_if_top16: pointsFor(category, tier, 16, n),
        trend, live: true,
        // the ten nearest seeds above him, for a by-hand read of their recent bouts
        neighbours: tagged.slice().sort((a, b) => b.strength - a.strength)
            .filter((x) => x.strength >= myStrength - 80).slice(-10).reverse()
            .map((x) => ({ name: x.name, tracker_id: x.tracker_id, strength: Math.round(x.strength), tag: x.tag, form: formLine(x.snap), pool: poolOf(x) })),
        // the whole registered field, strongest first, with his chance in one bout
        field_list: tagged.slice().sort((a, b) => b.strength - a.strength)
            .map((x) => ({ name: x.name, tracker_id: x.tracker_id, strength: Math.round(x.strength), tag: x.tag, form: formLine(x.snap), p_beat: +pwin(myStrength, x.strength).toFixed(2) }))
    };
}

export const tierOf = (title, category) => {
    const t = String(title || '').toLowerCase();
    if (/\bnac\b|north american cup/.test(t)) return 'nac';
    if (category === 'y12' || category === 'y14') return /\bsyc\b/.test(t) ? 'syc' : 'ryc';
    if (/\bsjcc\b/.test(t)) return 'sjcc';
    return 'regional';
};
export const categoryOf = (name) => {
    const n = String(name || '').toLowerCase();
    return /youth 12|y-?12/.test(n) ? 'y12' : /youth 14|y-?14/.test(n) ? 'y14' : /cadet/.test(n) ? 'cadet' : /junior/.test(n) ? 'junior'
        : /division i\b|div ?1\b|div i\b/.test(n) && !/division i[ai]|div ?2|div ?3/.test(n) ? 'div1' : null;
};
