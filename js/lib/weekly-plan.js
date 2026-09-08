// Weekly plan — the ask that keeps a family coming back.
//
// A fitness tracker does not describe your fitness; it tells you what to do
// today and counts it. This reads where the fencer stands right now - the
// last 90 days of bouts, how opponents have been scoring on him, the weakest
// rated skills, pool versus DE, sleep and energy, what was rehearsed, and how
// far off the next weekend is - and writes one thing to fix in each of Bouts,
// Body and Mind for this week, with the evidence, a number of sessions, and a
// tick per day done. Written once per week per fencer; ticked off after that.

import { el, todayISO, toast } from './util.js';
import { supa } from './supa.js';
import { safeWrite } from './offline.js';

const INK = 'var(--ink, #1A1D24)';
// Literal: var(--ink-mute) composites below AA on the cream surface.
const INK_MUTE = '#6B7280';
const GOOD = '#1f7a1f';
const WARN = '#B45309';

const AREA = { bout: 'Bouts', body: 'Body', mind: 'Mind' };
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
export function weekStart(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return iso(x); }
const daysUntil = (s) => Math.round((new Date(String(s).slice(0, 10) + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 864e5);

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------
async function gather(profile) {
    const since60 = daysAgo(60), since14 = daysAgo(14), today = todayISO();
    const [ts, bouts, skills, phys, ment, events, mine] = await Promise.all([
        supa.from('true_strength').select('*').eq('profile_id', profile.id).eq('days', 90).maybeSingle(),
        supa.from('bouts').select('date,outcome,conceded_actions,failure_patterns,scoring_actions').eq('profile_id', profile.id).is('deleted_at', null).gte('date', since60).order('date', { ascending: false }).limit(40),
        supa.from('skill_progress').select('skill_slug,latest,status,change,days_since').eq('profile_id', profile.id).order('latest', { ascending: true }).limit(4),
        supa.from('physical_sessions').select('date,drills_completed,energy_1_10,sleep_hours,injury_flag,soreness_severity').eq('profile_id', profile.id).gte('date', since14).order('date', { ascending: false }),
        supa.from('mental_sessions').select('date,visualization_done,breathing_done,in_bout_cue_practice,scenarios_rehearsed').eq('profile_id', profile.id).gte('date', since14),
        supa.from('season_events').select('tournament,start_date,city,projections').gte('start_date', today).order('start_date').limit(120),
        supa.from('member_events').select('tournament,event_date').eq('profile_id', profile.id).gte('event_date', today).order('event_date').limit(3)
    ]);

    // Next weekend that matters: a registered event, else the nearest worth-going weekend.
    let next = null;
    if (mine.data?.length) next = { name: mine.data[0].tournament || 'the next event', date: mine.data[0].event_date };
    else {
        const worth = (events.data || []).filter((e) => e.projections?.[profile.name]?.points_exp >= 8);
        if (worth.length) next = { name: worth[0].tournament, date: worth[0].start_date, city: worth[0].city };
    }
    const daysToEvent = next ? daysUntil(next.date) : null;

    // How opponents have been scoring on him, from his own logged bouts.
    const conceded = new Map();
    for (const b of bouts.data || []) {
        const c = b.conceded_actions;
        const items = Array.isArray(c) ? c : (c && typeof c === 'object' ? Object.entries(c).map(([k, v]) => ({ label: k, count: typeof v === 'number' ? v : (v?.count ?? 1) })) : []);
        for (const it of items) {
            const label = String(it.label || it.slug || it.name || '').toLowerCase().trim();
            if (!label) continue;
            conceded.set(label, (conceded.get(label) || 0) + Number(it.count ?? it.landed ?? 1));
        }
    }
    const topConceded = [...conceded.entries()].sort((a, b) => b[1] - a[1])[0] || null;

    const p = phys.data || [], m = ment.data || [];
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const plyoCount = p.filter((s) => (s.drills_completed || []).some((d) => d?.done && /plyo|jump|box|split squat|bound|hop/i.test(String(d.name || d.title || d.slug || d.category || '')))).length;
    return {
        ts: ts.data, next, daysToEvent, topConceded, boutsLogged: (bouts.data || []).length,
        skills: (skills.data || []).filter((s) => s.latest != null),
        body: { sessions: p.length, energy: avg(p.map((s) => s.energy_1_10).filter((x) => x != null)), sleep: avg(p.map((s) => Number(s.sleep_hours)).filter((x) => x > 0)), injury: p.some((s) => s.injury_flag), plyo: plyoCount },
        mind: { sessions: m.length, visualized: m.filter((s) => s.visualization_done).length, breathed: m.filter((s) => s.breathing_done).length, cue: m.filter((s) => s.in_bout_cue_practice).length, scenarios: m.reduce((a, s) => a + ((s.scenarios_rehearsed || []).length), 0) },
        de: profile.strength_de, pool: profile.strength_pool, name: profile.name
    };
}

// ---------------------------------------------------------------------------
// Rules. First match wins in each area. Every title is something a parent can
// say to the kid; every why is a fact from his own data.
// ---------------------------------------------------------------------------
const CONCEDE = [
    [/parry|riposte/, { title: 'Beat the parry-riposte', session: ['Feint-disengage attack: 3 sets of 10, finish on the second tempo', 'Attack only when his blade is off the line: two 5-touch bouts'] }],
    [/counter/, { title: 'Shorten the preparation', session: ['One-tempo attacks from lunge distance: 3 sets of 10', 'March and finish: never more than two steps before the final'] }],
    [/remise|renew|redouble/, { title: 'Close out after the parry', session: ['Parry-riposte with the riposte immediate: 3 sets of 10', 'Riposte to a second target when the first is covered'] }],
    [/attack|lunge|fleche/, { title: 'Own the distance', session: ['Retreat-parry-riposte on his first step: 3 sets of 10', 'Distance game: hold him at lunge-plus-one for three minutes'] }],
    [/line|point/, { title: 'Take the blade before you go', session: ['Beat-attack and bind-attack against point in line: 3 sets of 10', 'Never attack into a straight arm: two 5-touch bouts'] }]
];

function boutRule(ev, drills) {
    const t = ev.ts;
    if (ev.topConceded && ev.topConceded[1] >= 3) {
        const [label, n] = ev.topConceded;
        const hit = CONCEDE.find(([re]) => re.test(label));
        if (hit) return { ...hit[1], why: `Opponents scored ${n} touches on ${ev.name} with ${label} in his last logged bouts. That is the touch to take away first.`, target: 2, href: '#train', evidence: { conceded: label, n } };
    }
    if (t && t.vs_weaker >= 6 && t.losses_vs_weaker / t.vs_weaker >= 0.3) {
        return { title: 'Plan the first three touches', why: `${t.losses_vs_weaker} of ${t.vs_weaker} bouts against weaker fencers were lost in the last 90 days. Those bouts decide the seed.`, session: ['Before each practice bout, name the first three actions out loud', 'Two 5-touch bouts where the first touch must be the planned action', 'Write one line after: did the plan hold at 0–2?'], target: 2, href: '#bouts', evidence: { losses_vs_weaker: t.losses_vs_weaker, vs_weaker: t.vs_weaker } };
    }
    if (t && t.vs_stronger >= 5 && t.wins_vs_stronger / t.vs_stronger < 0.2) {
        return { title: 'Second intention against stronger fencers', why: `${t.wins_vs_stronger} of ${t.vs_stronger} bouts against stronger fencers were won in the last 90 days. They read the first attack; make the first attack the bait.`, session: ['False attack, parry-riposte: 3 sets of 10', 'Two 5-touch bouts against the strongest partner available, second intention only'], target: 2, href: '#train', evidence: { wins_vs_stronger: t.wins_vs_stronger, vs_stronger: t.vs_stronger } };
    }
    const weak = ev.skills[0];
    if (weak) {
        const label = weak.skill_slug.replace(/[-_]/g, ' ');
        const d = drills.filter((x) => x.skill_slug === weak.skill_slug).slice(0, 2);
        return { title: `Rebuild the ${label}`, why: `His lowest rated skill, at ${Number(weak.latest).toFixed(0)}${weak.status ? ` and ${weak.status}` : ''}${weak.days_since ? `, last rated ${weak.days_since} days ago` : ''}. Skills fall fastest when they are not touched.`, session: d.length ? d.map((x) => `${x.title}: ${x.suggested_reps || x.execution || ''}`.trim()) : [`Ten minutes of ${label} at the start of every practice`], target: 3, href: '#train', evidence: { skill: weak.skill_slug, latest: weak.latest } };
    }
    return { title: 'Log two bouts this week', why: ev.boutsLogged ? 'The plan sharpens with every bout that is scored. Two more this week.' : 'No bouts logged yet. The first two tell the app how opponents score on him.', session: ['Score every practice bout with the quick log', 'On one of them, mark how the opponent scored'], target: 2, href: '#bouts', evidence: { bouts_logged: ev.boutsLogged } };
}

function bodyRule(ev) {
    const b = ev.body, gap = ev.de && ev.pool ? ev.de - ev.pool : null;
    if (b.injury) return { title: 'Recover first', why: 'An injury was flagged in the last two weeks. Mobility and easy footwork only until it is clear.', session: ['Fifteen minutes of mobility, no lunging', 'Footwork at walking pace, no bounces'], target: 3, href: '#physical', evidence: { injury: true } };
    if (gap != null && gap >= 200) return { title: 'Pool-pace conditioning', why: `Pool strength trails DE by ${gap}. Five-touch bouts are a different sport: no time to warm into it.`, session: ['Six 5-touch bouts back to back with 60 seconds between, twice this week', 'Start every one with an attack in the first ten seconds'], target: 2, href: '#physical', evidence: { pool_gap: gap } };
    if (ev.daysToEvent != null && ev.daysToEvent <= 7) return { title: 'Taper for the weekend', why: `${ev.next.name} is in ${ev.daysToEvent} days. Sharp and rested beats tired and strong.`, session: ['Two short sessions: footwork and blade, nothing new', 'Lights out by 9:30 the two nights before'], target: 2, href: '#physical', evidence: { days_to_event: ev.daysToEvent } };
    if (b.sleep != null && b.sleep < 7.5) return { title: 'Sleep eight hours, five nights', why: `Average sleep logged is ${b.sleep.toFixed(1)} hours. Reaction time goes first when sleep goes.`, session: ['Screens off an hour before bed', 'Log the hours each morning'], target: 5, href: '#physical', evidence: { sleep: b.sleep } };
    if (b.energy != null && b.energy < 6) return { title: 'Get the energy back', why: `Energy averaged ${b.energy.toFixed(1)} of 10 over the last two weeks.`, session: ['Two easy sessions this week, not three hard ones', 'Water and a real breakfast on practice days'], target: 3, href: '#physical', evidence: { energy: b.energy } };
    if (b.plyo < 2) return { title: 'Two plyometric sessions', why: b.sessions ? `${b.plyo} plyometric session${b.plyo === 1 ? '' : 's'} logged in two weeks. The lunge is a jump.` : 'Nothing logged in two weeks. Start with the legs.', session: ['Box jumps 3 × 8, Bulgarian split squats 3 × 8 each leg', 'Lateral bounds 3 × 10, then lunges with a pause at the bottom'], target: 2, href: '#physical', evidence: { plyo: b.plyo, sessions: b.sessions } };
    return { title: 'Three sessions logged', why: 'Nothing is flagged. Keep the base: three sessions, all logged.', session: ['Footwork, legs, and one bout day'], target: 3, href: '#physical', evidence: { sessions: b.sessions } };
}

function mindRule(ev) {
    const t = ev.ts, m = ev.mind;
    if (t && t.vs_weaker >= 6 && t.losses_vs_weaker / t.vs_weaker >= 0.3) return { title: 'A reset cue for 0–5', why: `${t.losses_vs_weaker} losses to weaker fencers in 90 days. Those slip away at 0–3, not at 14–14.`, session: ['Pick one word for the reset; say it, breathe out, then fence the next touch', 'Practise the cue in three practice bouts, out loud between touches'], target: 3, href: '#mental', evidence: { losses_vs_weaker: t.losses_vs_weaker } };
    if (ev.daysToEvent != null && ev.daysToEvent <= 10 && m.visualized === 0) return { title: 'Visualise the first DE bout', why: `${ev.next.name} is in ${ev.daysToEvent} days and nothing has been visualised in two weeks.`, session: ['Five minutes, eyes closed: walk onto the strip, salute, first touch', 'Do it three evenings before the weekend'], target: 3, href: '#mental', evidence: { days_to_event: ev.daysToEvent } };
    if (m.scenarios === 0) return { title: 'Rehearse two scenarios', why: 'No scenarios rehearsed in two weeks. Down 0–4 and up 14–12 should both feel familiar before they happen.', session: ['Down 0–4: what is the next action, and the one after', 'Up 14–12: how do you finish without going passive'], target: 2, href: '#mental', evidence: { scenarios: 0 } };
    if (m.breathed < 3) return { title: 'Breathing before bed', why: `${m.breathed} breathing session${m.breathed === 1 ? '' : 's'} logged in two weeks. The between-touch reset is built at home, not on the strip.`, session: ['Four counts in, six out, for four minutes', 'Log it; four nights this week'], target: 4, href: '#mental', evidence: { breathed: m.breathed } };
    return { title: 'Keep the routine', why: 'Visualising, breathing and scenarios are all logged. Keep it going.', session: ['One visualisation, one breathing session, one scenario'], target: 3, href: '#mental', evidence: { ok: true } };
}

// ---------------------------------------------------------------------------
// Build or load this week's plan for a fencer.
// ---------------------------------------------------------------------------
export async function loadWeeklyPlan(profile) {
    const ws = weekStart();
    const { data: existing } = await supa.from('training_plan').select('*').eq('profile_id', profile.id).eq('week_start', ws);
    const have = new Map((existing || []).map((r) => [r.area, r]));
    if (have.size === 3) return [...have.values()];
    const ev = await gather(profile);
    const weakSlugs = ev.skills.map((s) => s.skill_slug);
    const { data: drills } = weakSlugs.length ? await supa.from('skill_drills').select('skill_slug,title,execution,suggested_reps,mode').in('skill_slug', weakSlugs).order('sort_order') : { data: [] };
    const made = { bout: boutRule(ev, drills || []), body: bodyRule(ev), mind: mindRule(ev) };
    for (const area of ['bout', 'body', 'mind']) {
        if (have.has(area)) continue;
        const r = made[area];
        const row = { profile_id: profile.id, week_start: ws, area, title: r.title, why: r.why, session: r.session, href: r.href, target_n: r.target, evidence: r.evidence, checkins: [] };
        try {
            const res = await safeWrite({ table: 'training_plan', op: 'upsert', onConflict: 'profile_id,week_start,area', payload: row });
            have.set(area, (res?.data && res.data[0]) || row);
        } catch (e) { have.set(area, row); }
    }
    return ['bout', 'body', 'mind'].map((a) => have.get(a)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// The card, one per screen.
// ---------------------------------------------------------------------------
export function renderPlanCard(plan, { compact = false } = {}) {
    const today = todayISO();
    const done = (plan.checkins || []).length;
    const doneToday = (plan.checkins || []).includes(today);
    const left = Math.max(0, plan.target_n - done);
    const wrap = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px', borderLeft: '3px solid ' + (left === 0 ? GOOD : WARN) } });
    wrap.appendChild(el('div', { class: 'label', style: { color: INK_MUTE } }, [`This week · ${AREA[plan.area] || plan.area}`]));
    wrap.appendChild(el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: compact ? '20px' : '24px', lineHeight: '1.15', margin: '4px 0 6px', color: INK } }, [plan.title]));
    wrap.appendChild(el('p', { style: { color: INK, fontSize: '13px', margin: '0 0 8px', lineHeight: '1.5' } }, [plan.why]));
    if (!compact && plan.session?.length) {
        wrap.appendChild(el('ul', { style: { margin: '0 0 10px', paddingLeft: '18px', color: INK, fontSize: '13px', lineHeight: '1.5' } }, plan.session.map((s) => el('li', {}, [s]))));
    }
    // Progress: one mark per session, filled as they are done.
    const dots = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, Array.from({ length: plan.target_n }, (_, i) =>
        el('span', { style: { width: '14px', height: '14px', borderRadius: '50%', border: '1.5px solid ' + (i < done ? GOOD : 'var(--rule-strong, #C9C2B4)'), background: i < done ? GOOD : 'transparent', display: 'inline-block' } })
    ).concat([el('span', { class: 'label', style: { color: left === 0 ? GOOD : INK_MUTE, marginLeft: '6px', fontWeight: '700' } }, [left === 0 ? 'Done for the week' : `${done} of ${plan.target_n} done`])]));
    const btn = el('button', { type: 'button', class: 'btn btn-mono-label btn-sm ' + (doneToday ? 'btn-ghost' : 'btn-primary'), disabled: doneToday }, [doneToday ? 'Done today' : 'Mark today done']);
    btn.onclick = async () => {
        btn.disabled = true;
        const checkins = [...(plan.checkins || []), today];
        try {
            await safeWrite({ table: 'training_plan', op: 'update', match: { id: plan.id }, payload: { checkins, updated_at: new Date().toISOString() } });
            plan.checkins = checkins;
            toast(checkins.length >= plan.target_n ? 'Week complete' : 'Logged');
            const fresh = renderPlanCard(plan, { compact });
            wrap.replaceWith(fresh);
        } catch (e) { btn.disabled = false; toast('Could not save: ' + (e.message || e), 'error'); }
    };
    const row = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [dots, btn]);
    wrap.appendChild(row);
    if (plan.href && !compact) wrap.appendChild(el('a', { href: plan.href, class: 'label', style: { display: 'inline-block', marginTop: '8px', color: INK, fontWeight: '700', textDecoration: 'underline', textUnderlineOffset: '3px' } }, ['Open the drills →']));
    return wrap;
}

// One line for the dashboard: "This week: 2 of 7 sessions done".
export function weekSummary(plans) {
    const target = plans.reduce((a, p) => a + p.target_n, 0);
    const done = plans.reduce((a, p) => a + Math.min(p.target_n, (p.checkins || []).length), 0);
    return { target, done };
}
