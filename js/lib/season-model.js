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
// 2026-27 Cadet Trial table (same as cadet_trial_points() in the database).
const CADET = {
    elite: [[1, 600], [2, 414], [4, 281.4], [8, 188.4], [16, 124.2], [32, 81], [64, 51.6], [128, 32.4], [256, 19.8]],
    challenger: [[1, 120], [2, 96], [4, 76.8], [8, 61.2], [16, 49.2], [32, 39.6], [64, 31.8], [128, 25.2], [256, 20.4]],
    sjcc: [[1, 90], [2, 74], [4, 60], [8, 49], [16, 40], [32, 33], [64, 27], [128, 22], [256, 18]],
    regional: [[1, 60], [2, 51], [4, 43.2], [8, 36.6], [16, 31.2], [32, 26.4], [64, 22.2], [128, 18.6], [256, 15.6]]
};

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
    if (cat === 'cadet') {
        const key = t === 'nac' ? 'challenger' : (t === 'sjcc' ? 'sjcc' : (t === 'elite' ? 'elite' : 'regional'));
        if (key === 'sjcc' && place > Math.min(64, Math.ceil(fieldSize * 0.4))) return 0;
        for (const [lim, pts] of CADET[key]) if (place <= lim) return pts;
    }
    return 0;
}

// ---- opponents ------------------------------------------------------------
// A fencer_snapshot row → the strength to seed them at, and a trend tag.
export function tiltedStrength(snap, listedStrength) {
    const base = snap?.strength_de ?? listedStrength ?? null;
    if (base == null) return { strength: null, tag: 'unknown' };
    if (!snap || snap.de_90d == null) return { strength: base, tag: 'steady' };
    if ((snap.events_180d ?? 0) === 0) return { strength: base - 50, tag: 'inactive' };
    if ((snap.events_90d ?? 0) < 2) return { strength: base, tag: 'steady' };
    const move = snap.de_now - snap.de_90d;
    const adj = Math.max(-200, Math.min(200, 2 * move));
    return { strength: base + adj, tag: move >= 40 ? 'rising' : move <= -40 ? 'fading' : 'steady' };
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
export function forecast({ entrants, snapshots, myStrength, myOfficial, myTrackerId, category, tier }) {
    const tagged = [];
    for (const e of entrants) {
        if (myTrackerId && Number(e.tracker_id) === Number(myTrackerId)) continue;
        const { strength, tag } = tiltedStrength(snapshots?.get(Number(e.tracker_id)), e.strength_de);
        if (strength != null && strength > 800 && strength < 3200) tagged.push({ ...e, strength, tag });
    }
    const field = tagged.map((x) => x.strength);
    if (field.length < 3) return null;
    const dist = simulate(field, myStrength);
    const n = field.length + 1;
    const cum = (k) => dist.slice(1, k + 1).reduce((a, b) => a + b, 0);
    let exp = 0, pts = 0, median = null;
    for (let p = 1; p <= n; p++) {
        exp += p * dist[p];
        pts += dist[p] * pointsFor(category, tier, p, n);
        if (median == null && cum(p) >= 0.5) median = p;
    }
    const trend = { rising: 0, fading: 0, inactive: 0 };
    for (const x of tagged) if (trend[x.tag] != null) trend[x.tag] += 1;
    return {
        field_n: n, registered: entrants.length,
        seed_form: 1 + field.filter((s) => s > myStrength).length,
        seed_official: 1 + field.filter((s) => s > myOfficial).length,
        p8: +cum(8).toFixed(2), p16: +cum(16).toFixed(2), p32: +cum(32).toFixed(2), p64: +cum(64).toFixed(2),
        exp: +exp.toFixed(1), median, points_exp: +pts.toFixed(1),
        points_if_top8: pointsFor(category, tier, 8, n), points_if_top16: pointsFor(category, tier, 16, n),
        trend, live: true,
        // the ten nearest seeds above him, for a by-hand read of their recent bouts
        neighbours: tagged.sort((a, b) => b.strength - a.strength)
            .filter((x) => x.strength >= myStrength - 80).slice(-10).reverse()
            .map((x) => ({ name: x.name, tracker_id: x.tracker_id, strength: Math.round(x.strength), tag: x.tag }))
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
    return /youth 12|y-?12/.test(n) ? 'y12' : /youth 14|y-?14/.test(n) ? 'y14' : /cadet/.test(n) ? 'cadet' : /junior/.test(n) ? 'junior' : null;
};
