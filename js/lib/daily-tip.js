// Daily tip — one sentence a parent can act on, and the reason under it.
//
// A fitness tracker does not show a parent forty numbers; it says "close the
// ring". This picks the one thing that matters most this week from what the
// app already knows - the next weekend worth going, the pool-versus-DE gap,
// the last ninety days of bouts, how long since he competed - and says it in
// the parent's words. Rules run in priority order; the first that fires wins.

import { el } from './util.js';
import { supa } from './supa.js';

const INK = 'var(--ink)';
// Literal: var(--ink-mute) composites below AA on the cream surface.
const INK_MUTE = '#6B7280';
const WARN = '#B45309';
const GOOD = '#1f7a1f';

const day = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00');
const daysUntil = (iso) => Math.round((day(iso) - day(new Date().toISOString())) / 864e5);
const fmt = (iso) => day(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const money = (n) => '$' + Math.round(n).toLocaleString();

// The best-value weekend for this fencer, the same way the Season screen ranks them.
function bestTrip(rows, name) {
    const trips = new Map();
    for (const r of rows) {
        const p = r.projections?.[name];
        if (!p || p.points_exp == null) continue;
        const key = r.tournament + '|' + String(r.start_date).slice(0, 7);
        const t = trips.get(key) || { tournament: r.tournament, start: r.start_date, city: r.city, travel: r.travel, cost: r.est_cost_two || 0, pts: 0 };
        t.pts += p.points_exp;
        t.start = t.start < r.start_date ? t.start : r.start_date;
        trips.set(key, t);
    }
    return [...trips.values()].filter((t) => t.pts >= 8).sort((a, b) => b.pts / Math.max(1, b.cost) - a.pts / Math.max(1, a.cost));
}

// "Las Vegas" reads better in a sentence than "2nd BBFC Duel in the Desert SYC & RCC".
const place = (t) => (t.city ? String(t.city).split(',')[0].trim() : t.tournament);

export async function pickDailyTip(profile) {
    const today = new Date().toISOString().slice(0, 10);
    const [tsRes, evRes, boutRes] = await Promise.all([
        supa.from('true_strength').select('*').eq('profile_id', profile.id).eq('days', 90).maybeSingle(),
        supa.from('season_events').select('tournament,start_date,city,travel,est_cost_two,projections').gte('start_date', today).order('start_date').limit(200),
        supa.from('fencer_bouts').select('bout_date').eq('profile_id', profile.id).order('bout_date', { ascending: false }).limit(1)
    ]);
    const t = tsRes.data;
    const ranked = bestTrip(evRes.data || [], profile.name);
    const trip = ranked[0] || null;
    // The best-value weekend inside the next four weeks, if there is one.
    const soon = ranked.find((x) => daysUntil(x.start) >= 0 && daysUntil(x.start) <= 28) || null;
    const lastBout = boutRes.data?.[0]?.bout_date || null;
    const name = profile.name;
    const de = profile.strength_de, pool = profile.strength_pool;

    // 1. Pools cost seeding, and there is an event to fix it for.
    if (soon && de && pool && de - pool >= 200) {
        return {
            tone: WARN,
            headline: `Pools are costing ${name} his seed. Two pool-pace sessions before ${place(soon)}.`,
            reason: `Pool strength ${pool} against ${de} in direct elimination, a gap of ${de - pool}. ${soon.tournament} is in ${daysUntil(soon.start)} days; a better pool result means an easier bracket there.`,
            href: '#train'
        };
    }
    // 2. Losing to fencers he should beat.
    if (t && t.vs_weaker >= 6 && t.losses_vs_weaker / t.vs_weaker >= 0.3) {
        return {
            tone: WARN,
            headline: `${name} is losing to fencers he should beat. This week: one plan for the first three touches.`,
            reason: `${t.losses_vs_weaker} of ${t.vs_weaker} bouts against weaker opponents were lost in the last 90 days. Those are the bouts that decide seeding, not the ones against the top seeds.`,
            href: '#train'
        };
    }
    // 3. A weekend worth going is close: make sure he is entered.
    if (soon) {
        return {
            tone: INK,
            headline: `Enter ${name} for ${place(soon)} now. ${soon.tournament}, ${fmt(soon.start)}.`,
            reason: `${daysUntil(soon.start)} days away, ${soon.travel === 'fly' ? 'a flight' : 'a drive'}. About ${Math.round(soon.pts)} national points expected for roughly ${money(soon.cost)}, the best value inside the next month. Regional entries usually close about a week before.`,
            href: '#season'
        };
    }
    // 4. Fencing above his seed: move him up.
    if (t && t.bouts >= 20 && t.perf_minus_official >= 100 && t.wins_vs_stronger >= 3) {
        return {
            tone: GOOD,
            headline: `${name} is fencing ${t.perf_minus_official} points above his seed. Enter him a category up at the next regional.`,
            reason: `${t.wins}–${t.bouts - t.wins} in the last 90 days, with ${t.wins_vs_stronger} wins over stronger fencers. The official number has not caught up yet; the seeding will follow the results.`,
            href: '#season'
        };
    }
    // 5. Too long without a bout.
    if (lastBout && -daysUntil(lastBout) >= 45) {
        return {
            tone: WARN,
            headline: `${name} has not competed in ${-daysUntil(lastBout)} days. Put a local event or a practice-bout day on the calendar.`,
            reason: 'Strength ratings only move at competitions, and pool habits fade fastest. One local Sunday keeps the seeding current.',
            href: '#season'
        };
    }
    // 6. Nothing urgent.
    return {
        tone: INK,
        headline: `Nothing urgent for ${name} today. Log the practice.`,
        reason: trip ? `Next weekend worth going: ${trip.tournament}, ${fmt(trip.start)}.` : 'Add his next event on the Season screen and the tip will follow it.',
        href: '#lessons'
    };
}

export function renderDailyTip(tip) {
    return el('a', { href: tip.href, class: 'card', style: { display: 'block', margin: '0 var(--gut) 18px', textDecoration: 'none', color: INK, borderLeft: '3px solid ' + tip.tone } }, [
        el('div', { class: 'label', style: { color: INK_MUTE } }, ['Today · one thing']),
        el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '24px', lineHeight: '1.15', margin: '4px 0 6px', color: INK } }, [tip.headline]),
        el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '0', lineHeight: '1.5' } }, [tip.reason])
    ]);
}
