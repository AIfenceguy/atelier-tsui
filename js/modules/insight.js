// Competition Insight — where a fencer is likely to finish, and why.
//
// Two strengths sit side by side on purpose. FencingTracker's official number
// is a Bayesian estimate over every bout ever recorded: right for seeding, and
// slow to move. Form strength is computed here from the last twelve months of
// placings, mapped onto real strength bands by percentile of field, weighted
// so that a result from three months ago counts half as much as one from
// today. Every figure on this screen traces back to a row the fencer can see
// in the results list at the bottom.
//
// The screen does not pick one. It projects the next events under both and
// lets the gap between them say what it says.

import { el, toast } from '../lib/util.js';
import { supa } from '../lib/supa.js';
import { activeProfile } from '../lib/state.js';

const INK = 'var(--ink)';
// Literal: var(--ink-mute) composites to ~3.5:1 on the cream surface.
const INK_MUTE = '#6B7280';
const GOOD = '#1f7a1f';
const WARN = '#B45309';
const BAD = '#9b2230';

const CAT_LABEL = { y10: 'Y10', y12: 'Y12', y14: 'Y14', cadet: 'Cadet', junior: 'Junior', senior: 'Senior', div1: 'Div I', div2: 'Div II' };
const catLabel = (c) => CAT_LABEL[String(c || '').toLowerCase()] || String(c || '').toUpperCase();

const label = (text, color, extra = {}) =>
    el('div', { class: 'label', style: { color: color || INK_MUTE, ...extra } }, [text]);

const serif = (text, size = '26px', color = INK) => el('div', {
    style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: size, lineHeight: '1.15', color }
}, [text]);

const num = (text, color = INK, size = '22px') =>
    el('span', { class: 'num', style: { color, fontSize: size, fontWeight: '600' } }, [text]);

const fmtDay = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00')
    .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

// Same rule as project_finish() in the database: the band whose strength
// range contains this strength, else the band with the nearest average.
function projectBand(bands, strength) {
    if (!bands?.length || strength == null) return null;
    const sorted = bands.slice().sort((a, b) => {
        const lo = (x) => Math.min(x.min_strength ?? x.avg_strength, x.avg_strength);
        const hi = (x) => Math.max(x.max_strength ?? x.avg_strength, x.avg_strength);
        const inA = strength >= lo(a) && strength <= hi(a) ? 0 : 1;
        const inB = strength >= lo(b) && strength <= hi(b) ? 0 : 1;
        if (inA !== inB) return inA - inB;
        return Math.abs(a.avg_strength - strength) - Math.abs(b.avg_strength - strength);
    });
    return sorted[0];
}

export async function mountInsight(root) {
    const profile = activeProfile();
    if (!profile) {
        root.appendChild(el('div', { class: 'empty' }, [
            el('p', { class: 'empty-line' }, ['Pick a fencer to see their outlook.'])
        ]));
        return;
    }

    root.appendChild(el('div', { style: { padding: '40px var(--gut) 8px' } }, [
        el('h1', { class: 'page-eyebrow' }, ['Competition Insight']),
        el('div', { class: 'today-sub' }, [el('span', {}, [profile.name.toUpperCase()])]),
        // The bottom nav is twelve tabs wide on a phone; the season plan is the
        // screen this one leads to, so it gets a link here too.
        el('a', { href: '#season', class: 'label', style: { display: 'inline-block', marginTop: '10px', color: INK, fontWeight: '700', textDecoration: 'underline', textUnderlineOffset: '3px' } }, ['Season plan: every weekend ranked by points per dollar →'])
    ]));

    const body = el('div', {});
    root.appendChild(body);
    body.appendChild(el('div', { class: 'empty' }, [el('p', { class: 'empty-line' }, ['Reading the results…'])]));

    const today = new Date().toISOString().slice(0, 10);
    const [formRes, detailRes, eventsRes, bandsRes, goalsRes, rulesRes, casesRes, oppRes, winRes, flagRes, briefRes] = await Promise.all([
        supa.from('fencer_form').select('*').eq('profile_id', profile.id),
        supa.from('fencer_form_detail').select('*').eq('profile_id', profile.id),
        supa.from('events').select('*').gte('event_date', today).order('event_date'),
        supa.from('event_strength_bands').select('*').not('event_id', 'is', null),
        supa.from('event_goals').select('*').eq('profile_id', profile.id),
        supa.from('pathway_rules').select('*').order('sort_order'),
        supa.from('pathway_cases').select('*').order('birth_year'),
        supa.from('opponent_profiles').select('tracker_id,name,club,birth_year,rating,strength_de,strength_pool,tracker_url,fetched_at'),
        supa.from('opponent_windows').select('*'),
        supa.from('opponent_flags').select('tracker_id,flags,days_since_last'),
        supa.from('coach_notes').select('response_text,created_at,input_summary').eq('profile_id', profile.id).eq('kind', 'opponent-tier').order('created_at', { ascending: false })
    ]);
    const oppById = new Map((oppRes.data || []).map((o) => [o.tracker_id, o]));
    const winsById = new Map();
    for (const w of (winRes.data || [])) {
        if (!winsById.has(w.tracker_id)) winsById.set(w.tracker_id, {});
        winsById.get(w.tracker_id)[w.window_days] = w;
    }
    const flagsById = new Map((flagRes.data || []).map((f) => [f.tracker_id, f]));
    // Placings per category. A Y14 podium and a Division I filler finish are
    // not the same story, so the roster for a Y14 event reads Y14 placings only
    // and shows the other categories beside them.
    const [{ data: winCatRows }, { data: flagCatRows }] = await Promise.all([
        supa.from('opponent_windows_by_category').select('*'),
        supa.from('opponent_flags_by_category').select('tracker_id,category,flags,events_365,median_365')
    ]);
    const winsByCat = new Map();
    for (const w of (winCatRows || [])) {
        const c = String(w.category || '').toLowerCase();
        if (!winsByCat.has(w.tracker_id)) winsByCat.set(w.tracker_id, {});
        const byCat = winsByCat.get(w.tracker_id);
        if (!byCat[c]) byCat[c] = {};
        byCat[c][w.window_days] = w;
    }
    const flagsByCat = new Map();
    for (const f of (flagCatRows || [])) {
        if (!flagsByCat.has(f.tracker_id)) flagsByCat.set(f.tracker_id, {});
        flagsByCat.get(f.tracker_id)[String(f.category || '').toLowerCase()] = f;
    }
    const briefByEvent = new Map();
    for (const n of (briefRes.data || [])) {
        const k = n.input_summary?.event_id;
        if (k && !briefByEvent.has(k)) briefByEvent.set(k, n);
    }

    body.innerHTML = '';
    const forms = formRes.data || [];
    const detail = detailRes.data || [];

    if (!forms.length) {
        body.appendChild(el('div', { class: 'empty' }, [
            el('p', { class: 'empty-line' }, ['No results on file yet for this fencer.'])
        ]));
        return;
    }

    const official = forms[0].official_strength;
    const pool = forms[0].pool_strength;
    const ciLo = forms[0].strength_de_low;
    const ciHi = forms[0].strength_de_high;
    const formByCat = new Map(forms.map((f) => [f.category, f]));

    // --- Strength card ---------------------------------------------------
    const strengthCard = el('div', { class: 'card', style: { margin: '10px var(--gut) 18px' } });
    strengthCard.appendChild(label('Strength'));

    const row = (title, value, sub, color) => el('div', {
        style: { display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--rule)' }
    }, [
        el('span', { style: { color: INK, fontSize: '15px', minWidth: '150px', flex: '1 1 auto' } }, [title]),
        num(value == null ? '—' : String(value), color),
        sub ? el('span', { style: { color: INK_MUTE, fontSize: '12px' } }, [sub]) : null
    ]);

    strengthCard.appendChild(row('Official (direct elimination)', official,
        ciLo && ciHi ? `95% range ${ciLo} – ${ciHi}` : 'FencingTracker'));
    if (pool != null) {
        const gap = official - pool;
        strengthCard.appendChild(row('Official (pools)', pool,
            gap > 150 ? `${gap} below DE — pools are costing seeding` : 'FencingTracker',
            gap > 150 ? WARN : INK));
    }
    for (const f of forms.slice().sort((a, b) => String(a.category).localeCompare(String(b.category)))) {
        const g = Number(f.form_minus_official) || 0;
        const color = Math.abs(g) < 60 ? INK : g > 0 ? GOOD : WARN;
        strengthCard.appendChild(row(
            `Form in ${catLabel(f.category)}`, f.form_strength,
            `${g >= 0 ? '+' : ''}${g} vs official · best recent ${f.best_recent ?? '—'} · ${f.results_in_category} result${f.results_in_category === 1 ? '' : 's'}`,
            color
        ));
    }
    strengthCard.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', lineHeight: '1.6', margin: '12px 0 0' } }, [
        'Form is worked out from the last twelve months of placings: each finish is turned into the strength ',
        'a fencer would usually need to finish there, then averaged with recent results counting more. ',
        'Where form and official agree, the official number is telling the truth. Where they split, the gap is the story.'
    ]));
    body.appendChild(strengthCard);

    // --- Upcoming events -------------------------------------------------
    const events = (eventsRes.data || []).filter((e) => e.category);
    const bandsByEvent = new Map();
    for (const b of (bandsRes.data || [])) {
        if (!bandsByEvent.has(b.event_id)) bandsByEvent.set(b.event_id, []);
        bandsByEvent.get(b.event_id).push(b);
    }
    const goalByEvent = new Map((goalsRes.data || []).map((g) => [g.event_id, g]));

    const withBands = events.filter((e) => bandsByEvent.has(e.id));
    if (withBands.length) {
        body.appendChild(label('Upcoming — projected finish', INK_MUTE, { margin: '0 var(--gut) 6px' }));
    }

    for (const e of withBands) {
        const bands = bandsByEvent.get(e.id);
        const field = bands[0]?.field_size;
        const f = formByCat.get(e.category);
        const goal = goalByEvent.get(e.id);

        const offBand = projectBand(bands, official);
        const formBand = f ? projectBand(bands, f.form_strength) : null;
        const bestBand = f?.best_recent ? projectBand(bands, f.best_recent) : null;

        const card = el('div', { class: 'card', style: { margin: '0 var(--gut) 12px' } });
        card.appendChild(el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } }, [
            serif(e.name, '22px'),
            el('span', { class: 'label', style: { color: INK_MUTE } }, [`${fmtDay(e.event_date)} · ${field} entrants`])
        ]));

        const proj = (title, band, strength, color) => band ? el('div', {
            style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', padding: '7px 0', borderTop: '1px solid var(--rule)' }
        }, [
            el('span', { style: { color: INK_MUTE, fontSize: '13px', minWidth: '150px', flex: '1 1 auto' } }, [title]),
            num(`${band.finish_lo}–${band.finish_hi}`, color, '20px'),
            el('span', { style: { color: INK_MUTE, fontSize: '12px' } }, [`of ${field} · at ${strength}`])
        ]) : null;

        card.appendChild(el('div', { style: { marginTop: '8px' } }, [
            proj('On official strength', offBand, official, INK),
            f ? proj(`On ${catLabel(e.category)} form`, formBand, f.form_strength, Math.abs(f.form_minus_official) < 60 ? INK : GOOD) : null,
            f?.best_recent ? proj('On best recent day', bestBand, f.best_recent, GOOD) : null
        ]));

        if (goal?.seed_estimate) {
            card.appendChild(el('div', { style: { color: INK_MUTE, fontSize: '13px', marginTop: '10px', lineHeight: '1.5' } }, [
                `Seeded ${goal.seed_estimate}. `,
                goal.target_finish ? `Target top ${goal.target_finish}` : '',
                goal.stretch_finish ? `, stretch top ${goal.stretch_finish}.` : '.'
            ]));
        }
        if (goal?.process_goal) {
            card.appendChild(el('div', { style: { color: INK, fontSize: '14px', marginTop: '6px', lineHeight: '1.55', fontStyle: 'italic', fontFamily: 'var(--serif)', fontSize: '16px' } }, [goal.process_goal]));
        }

        // Say plainly what the two numbers disagree on, if they do.
        if (f && offBand && formBand && (offBand.finish_lo !== formBand.finish_lo)) {
            const better = f.form_strength > official ? 'better' : 'worse';
            card.appendChild(el('div', { style: { color: better === 'better' ? GOOD : WARN, fontSize: '13px', marginTop: '8px', fontWeight: '700' } }, [
                `Recent ${catLabel(e.category)} form points ${better} than the seeding does.`
            ]));
        }

        if (e.tracker_url) {
            card.appendChild(el('a', {
                href: e.tracker_url, target: '_blank', rel: 'noopener', class: 'label',
                style: { color: 'var(--cta, #0071e3)', display: 'inline-block', marginTop: '10px' }
            }, ['Full entry list on FencingTracker \u2192']));
        }

        // The tier above: the fencers one band up, read from twelve months of
        // their own results. Strength says where they are seeded; the windows
        // say what they have actually done lately.
        card.appendChild(await tierBlock(e, profile, goal, oppById, winsByCat, flagsByCat, flagsById, briefByEvent.get(e.id)));
        body.appendChild(card);
    }

    // --- How fencers actually climb -----------------------------------------
    // The rules a new fencing parent is never told, each with the evidence it
    // came from. Rules tagged for the unrated apply to Kaylan; the rest to both.
    // Unrated is stored as 'U', a truthy string - so !profile.rating was false
    // and Kaylan would never have seen the one rule written about his own
    // results. Case-insensitive, as every string comparison here should be.
    const ratingKey = String(profile.rating || '').trim().toLowerCase();
    const isUnrated = ratingKey === '' || ratingKey === 'u';
    const rules = (rulesRes.data || []).filter((r) => {
        const a = String(r.applies_to || '').toLowerCase();
        return a === 'everyone' || (a === 'unrated' && isUnrated) || a === ratingKey;
    });
    const cases = casesRes.data || [];
    if (rules.length || cases.length) {
        body.appendChild(label('How fencers actually climb', INK_MUTE, { margin: '18px var(--gut) 6px' }));
        body.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '0 var(--gut) 10px', lineHeight: '1.5' } }, [
            'Read off real FencingTracker histories. Each rule carries the result it came from.'
        ]));
        for (const r of rules) {
            body.appendChild(el('div', { class: 'card', style: { margin: '0 var(--gut) 10px' } }, [
                serif(r.rule, '19px'),
                el('p', { style: { color: INK_MUTE, fontSize: '13px', lineHeight: '1.6', margin: '8px 0 0' } }, [r.evidence])
            ]));
        }
        for (const c of cases) {
            body.appendChild(el('div', { class: 'card', style: { margin: '0 var(--gut) 10px' } }, [
                el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } }, [
                    el('span', { style: { color: INK, fontSize: '15px', fontWeight: '600' } }, [c.fencer]),
                    el('span', { class: 'label', style: { color: INK_MUTE } }, [`${c.birth_year} · ${c.club}`])
                ]),
                serif(c.headline, '20px', GOOD),
                el('p', { style: { color: INK, fontSize: '13px', lineHeight: '1.6', margin: '8px 0 0' } }, [c.detail]),
                c.tracker_url
                    ? el('a', { href: c.tracker_url, target: '_blank', rel: 'noopener', class: 'label',
                               style: { color: 'var(--cta, #0071e3)', display: 'inline-block', marginTop: '8px' } }, ['Profile on FencingTracker →'])
                    : null
            ]));
        }
    }

    // --- Results, with what each one implies ------------------------------
    body.appendChild(label('Last 12 months — what each result implies', INK_MUTE, { margin: '18px var(--gut) 6px' }));
    body.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '0 var(--gut) 8px', lineHeight: '1.5' } }, [
        'Implied is the strength usually needed to finish where you did. Weight is how much it counts today. ',
        'A class of U means the event could not award a rating to anyone.'
    ]));

    for (const r of detail) {
        const pct = r.percentile;
        const isU = String(r.event_class || '').toUpperCase() === 'U';
        body.appendChild(el('div', {
            style: {
                display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap',
                padding: '9px var(--gut)', borderTop: '1px solid var(--rule)'
            }
        }, [
            el('span', { class: 'label', style: { color: INK_MUTE, minWidth: '78px' } }, [fmtDay(r.result_date)]),
            el('span', { style: { color: INK, fontSize: '14px', flex: '1 1 160px' } }, [r.tournament]),
            el('span', { class: 'label', style: { color: INK_MUTE, minWidth: '46px' } }, [catLabel(r.category)]),
            num(`${r.place}/${r.field_size}`, pct <= 15 ? GOOD : pct <= 40 ? INK : INK_MUTE, '15px'),
            el('span', { class: 'label', style: { color: isU ? WARN : INK_MUTE, minWidth: '46px' } }, [r.event_class || '—']),
            r.rating_earned ? el('span', { class: 'label', style: { color: GOOD } }, [`earned ${r.rating_earned}`]) : null,
            r.implied != null
                ? el('span', { class: 'num', style: { color: INK, fontSize: '13px' } }, [`→ ${r.implied}`])
                : el('span', { style: { color: INK_MUTE, fontSize: '12px' } }, ['no bands for this category']),
            el('span', { style: { color: INK_MUTE, fontSize: '11px', fontFamily: 'var(--mono)' } }, [`×${r.weight}`])
        ]));
    }

    body.appendChild(el('p', {
        style: { color: INK_MUTE, fontSize: '12px', lineHeight: '1.6', padding: '18px var(--gut) 40px', margin: '0', borderTop: '1px solid var(--rule)' }
    }, [
        'Strength bands come from live event entry lists on FencingTracker. Results in categories with no bands on file ',
        '(Senior, Div II) are shown but not counted. Form uses a 90-day half-life and counts results from other ',
        'categories at half weight.'
    ]));
}

const pctColor = (v) => v == null ? INK_MUTE : v <= 15 ? GOOD : v <= 40 ? INK : INK_MUTE;

const CAT_ORDER = ['y8', 'y10', 'y12', 'y14', 'cadet', 'junior', 'div3', 'div2', 'div1', 'senior', 'vet'];
const catRank = (c) => { const i = CAT_ORDER.indexOf(String(c || '').toLowerCase()); return i < 0 ? 99 : i; };

async function tierBlock(e, profile, goal, oppById, winsByCat, flagsByCat, flagsById, cachedBrief) {
    const cat = String(e.category || '').toLowerCase();
    // Higher categories translated up onto this category's scale at half
    // weight (Cadet and Junior for a Y14 event); lower ones never count.
    const scaledById = new Map();
    try {
        const { data } = await supa.rpc('opponent_windows_for', { p_target: cat });
        for (const r of data || []) { if (!scaledById.has(r.tracker_id)) scaledById.set(r.tracker_id, {}); scaledById.get(r.tracker_id)[r.window_days] = r; }
    } catch (err) { console.warn('scaled windows skipped', err); }
    const wrap = el('div', { style: { marginTop: '14px', borderTop: '1px solid var(--rule)', paddingTop: '12px' } });
    let tier = [];
    try {
        const { data, error } = await supa.rpc('tier_above', { p_event_id: e.id, p_profile_id: profile.id });
        if (error) throw error;
        tier = data || [];
    } catch (err) {
        wrap.appendChild(el('div', { style: { color: INK_MUTE, fontSize: '13px' } }, ['Could not load the tier: ' + (err.message || err)]));
        return wrap;
    }
    if (!tier.length) {
        wrap.appendChild(el('div', { style: { color: INK_MUTE, fontSize: '13px' } }, ['No entry list loaded for this event yet.']));
        return wrap;
    }

    const bandLabel = tier[0]?.band ? `seeds ${tier[0].band}` : '';
    wrap.appendChild(el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } }, [
        label(`The tier above ${goal?.seed_estimate ? `seed ${goal.seed_estimate}` : profile.name}`),
        el('span', { class: 'label', style: { color: INK_MUTE } }, [`${tier.length} fencers \u00b7 ${bandLabel}`])
    ]));
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '2px 0 8px', lineHeight: '1.5' } }, [
        `${catLabel(cat)} placings only: median finish as a percentage of a ${catLabel(cat)} field over 3, 6, 9 and 12 months \u2014 lower is better, 10 means top tenth. `,
        `The line under each name shows his 12-month median in every category he enters. Where he also fences above ${catLabel(cat)}, a second line scales those results up onto the ${catLabel(cat)} scale at half weight. Lower categories never count toward a ${catLabel(cat)} number, and Division I has no reference to scale from, so it is listed only. Flags are read from placings in this category alone.`
    ]));

    // column header
    wrap.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '34px 1fr 52px 52px 52px 52px', gap: '8px', alignItems: 'baseline', padding: '4px 0' } }, [
        el('span', { class: 'label', style: { color: INK_MUTE } }, ['#']),
        el('span', { class: 'label', style: { color: INK_MUTE } }, ['Fencer']),
        ...['3 mo', '6 mo', '9 mo', '12 mo'].map((t) => el('span', { class: 'label', style: { color: INK_MUTE, textAlign: 'right' } }, [t]))
    ]));

    for (const t of tier) {
        const o = oppById.get(t.tracker_id) || {};
        const byCat = winsByCat.get(t.tracker_id) || {};
        const w = byCat[cat] || {};
        const m = (d) => w[d]?.median_pct;
        // Flags for this category; if he has never fenced it, say so, and keep
        // only the "rusty" flag, which is about him and not the category.
        const catFlags = flagsByCat.get(t.tracker_id)?.[cat];
        const fl = catFlags ? (catFlags.flags || [])
            : [`no ${catLabel(cat)} results:nothing in this category in a year`,
               ...(flagsById.get(t.tracker_id)?.flags || []).filter((f) => /^rusty/i.test(String(f)))];
        // Every category he enters, 12-month median and count, event category first.
        const breakdown = Object.keys(byCat).filter((c) => byCat[c][365]).sort((a, b) => (a === cat ? -1 : b === cat ? 1 : catRank(a) - catRank(b)))
            .map((c) => ({ c, med: byCat[c][365].median_pct, n: byCat[c][365].events }));
        const row = el('div', { style: { borderTop: '1px solid var(--rule)', padding: '9px 0' } });
        row.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '34px 1fr 52px 52px 52px 52px', gap: '8px', alignItems: 'baseline' } }, [
            el('span', { class: 'num', style: { color: INK_MUTE, fontSize: '12px' } }, [String(t.rank)]),
            el('div', {}, [
                o.tracker_url
                    ? el('a', { href: o.tracker_url, target: '_blank', rel: 'noopener', style: { color: INK, fontSize: '15px', fontWeight: '700', textDecoration: 'none' } }, [o.name || `#${t.tracker_id}`])
                    : el('span', { style: { color: INK, fontSize: '15px', fontWeight: '700' } }, [o.name || `#${t.tracker_id}`]),
                el('div', { class: 'label', style: { color: INK_MUTE, marginTop: '2px' } }, [
                    [o.club, o.rating, o.strength_de ? `DE ${o.strength_de}` : null, o.strength_pool ? `pool ${o.strength_pool}` : null].filter(Boolean).join(' \u00b7 ')
                ]),
                breakdown.length ? el('div', { class: 'label', style: { color: INK_MUTE, marginTop: '3px', display: 'flex', flexWrap: 'wrap', gap: '4px 10px' } },
                    breakdown.map((b) => el('span', { style: b.c === cat ? { color: INK, fontWeight: '700' } : {} }, [`${catLabel(b.c)} ${b.med}% (${b.n})`]))) : null,
                (() => {
                    // Second line: this category plus higher ones scaled up, half weight.
                    const sc = scaledById.get(t.tracker_id) || {};
                    const has = [90, 180, 270, 365].some((d) => (sc[d]?.events_scaled || 0) > 0);
                    if (!has) return null;
                    const cells = [90, 180, 270, 365].map((d) => sc[d] ? `${sc[d].median_pct}%` : '—');
                    const nUp = sc[365]?.events_scaled || 0;
                    return el('div', { class: 'label', style: { color: INK_MUTE, marginTop: '3px' } }, [
                        `With ${nUp} higher-category result${nUp === 1 ? '' : 's'} scaled up to ${catLabel(cat)} at half weight: ${cells.join(' · ')}`
                    ]);
                })()
            ]),
            ...[90, 180, 270, 365].map((d) => el('span', { class: 'num', style: { color: pctColor(m(d)), fontSize: '14px', textAlign: 'right', fontWeight: (m(d) != null && m(d) <= 15) ? '700' : '500' } }, [m(d) == null ? '\u2014' : `${m(d)}%`]))
        ]));
        if (fl.length) {
            row.appendChild(el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' } },
                fl.map((f) => {
                    const [head, detail] = String(f).split(':');
                    const bad = /rusty|fades|dropping|thin|soft|erratic|no results/i.test(head);
                    return el('span', {
                        class: 'label', title: detail || '',
                        style: { border: '1px solid ' + (bad ? WARN : 'var(--rule-strong)'), color: bad ? WARN : INK_MUTE, borderRadius: 'var(--r-pill)', padding: '3px 8px', fontWeight: bad ? '700' : '500' }
                    }, [head + (detail ? ` \u00b7 ${detail}` : '')]);
                })));
        }
        wrap.appendChild(row);
    }

    // Their records go stale the moment they fence again. One tap re-reads
    // each fencer in this tier from FencingTracker (on demand, one fencer at
    // a time, cached three days) and the windows and flags recompute.
    {
        const ages = tier.map((t) => oppById.get(t.tracker_id)?.fetched_at).filter(Boolean).map((d) => Date.now() - new Date(d).getTime());
        const oldest = ages.length ? Math.round(Math.max(...ages) / 864e5) : null;
        const rb = el('button', { class: 'btn btn-ghost btn-mono-label', style: { marginTop: '10px', width: '100%' } }, [
            oldest == null ? 'Read their records from FencingTracker' : `Re-read their records · oldest copy ${oldest} day${oldest === 1 ? '' : 's'} old`
        ]);
        rb.onclick = async () => {
            rb.disabled = true;
            const ids = tier.map((t) => Number(t.tracker_id)).filter(Boolean);
            let done = 0, failed = 0;
            // Twelve per call; the function reads them one at a time.
            for (let i = 0; i < ids.length; i += 12) {
                const chunk = ids.slice(i, i + 12);
                rb.textContent = `Reading ${Math.min(i + chunk.length, ids.length)} of ${ids.length}…`;
                try {
                    const { data, error } = await supa.functions.invoke('refresh-peer', { body: { tracker_ids: chunk, force: true } });
                    if (error || data?.error) failed += chunk.length;
                    else failed += Object.values(data?.results || {}).filter((s) => String(s).startsWith('failed')).length;
                } catch (_) { failed += chunk.length; }
                done += chunk.length;
            }
            if (failed) toast(`${failed} of ${ids.length} could not be read`, 'error');
            location.reload();
        };
        wrap.appendChild(rb);
    }

    // The brief: one AI read of the whole tier, cached per event.
    const briefOut = el('div', {});
    const renderBrief = (n) => {
        briefOut.innerHTML = '';
        if (!n) return;
        briefOut.appendChild(el('div', { class: 'label', style: { color: INK_MUTE, marginTop: '14px' } }, [
            `Coach brief \u00b7 ${String(n.created_at).slice(0, 10)}`
        ]));
        String(n.response_text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).forEach((p) => {
            briefOut.appendChild(el('p', { style: { color: INK, fontSize: '14px', lineHeight: '1.6', margin: '8px 0 0' } }, [p]));
        });
    };
    renderBrief(cachedBrief);

    const btn = el('button', { class: 'btn btn-mono-label', style: { marginTop: '12px', width: '100%' } }, [cachedBrief ? 'Refresh the brief' : 'Brief this tier']);
    btn.onclick = async () => {
        btn.disabled = true; btn.textContent = 'Reading twelve months of results\u2026';
        try {
            const { data, error } = await supa.functions.invoke('claude-coach', { body: { action: 'opponent-tier-brief', profile_id: profile.id, event_id: e.id } });
            if (error) throw error;
            if (data?.error) throw new Error(data.error);
            renderBrief({ response_text: data.text, created_at: new Date().toISOString() });
            toast('Brief ready');
            btn.textContent = 'Refresh the brief';
        } catch (err) {
            toast('Could not brief: ' + (err.message || err), 'error');
            btn.textContent = cachedBrief ? 'Refresh the brief' : 'Brief this tier';
        } finally { btn.disabled = false; }
    };
    wrap.appendChild(btn);
    wrap.appendChild(briefOut);
    return wrap;
}
