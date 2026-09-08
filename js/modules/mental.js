// Module 3.5 — Mental training.
// Daily meditation + visualization toggles + scenario rehearsal.
// v1 carryovers: Raedyn instinct catalog, Kaylan speed self-rating.
// Tournament-day mental checklist when within 7 days.

import { el, todayISO, fmtDate, daysUntil, toast } from '../lib/util.js';
import { activeProfile } from '../lib/state.js';
import { getMentalForDate, nextTournament, listBouts } from '../lib/db.js';
import { safeWrite } from '../lib/offline.js';
import { loadWeeklyPlan, renderPlanCard } from '../lib/weekly-plan.js';
import { scaleSlider, chipGroup, chipArrayEditor } from '../lib/chips.js';

const SCENARIOS = [
    { slug: 'tied-14',     label: '14-14 in DE — what\'s your move?' },
    { slug: 'down-2-4',    label: 'Down 2–4 in pool — read the tactic' },
    { slug: 'first-touch', label: 'First touch of the tournament' },
    { slug: 'after-loss',  label: 'Reset after losing a bout you should\'ve won' },
    { slug: 'long-day',    label: 'Mid-tournament fatigue — focus reset' }
];

const MEDITATION_TECHNIQUES = ['breathwork', 'visualization', 'body-scan', 'mixed'];

const TOURNAMENT_NIGHT_BEFORE = [
    'Equipment checked + bag packed',
    'Lights out by target time',
    'Phone away from bed',
    'Hydrated + ate enough'
];
const TOURNAMENT_MORNING_OF = [
    'Real breakfast eaten',
    'Hydrated',
    'Arrival time set with buffer',
    'Mask + lame + body cord checked again'
];

export async function mountMental(root) {
    const profile = activeProfile();
    if (!profile) return root.appendChild(el('div', { class: 'empty' }, ['Pick a profile.']));

    const date = todayISO();
    const [existing, nextT, recentBouts] = await Promise.all([
        getMentalForDate(date),
        nextTournament(),
        listBouts({ limit: 5 })
    ]);

    const daysToT = nextT ? daysUntil(nextT.start_date) : null;
    const tournamentMode = daysToT != null && daysToT >= 0 && daysToT <= 7;

    root.appendChild(el('div', { style: { padding: '40px var(--gut) 8px' } }, [
        el('h1', { class: 'page-eyebrow' }, ['Mind']),
        el('div', { class: 'today-sub' }, [
            el('span', {}, [profile.name.toUpperCase()]),
            el('span', {}, [fmtDate(date).toUpperCase()])
        ])
    ]));

    // This week's one thing for the head, from his own record, with the tick.
    try {
        const plans = await loadWeeklyPlan(profile);
        const p = plans.find((x) => x.area === 'mind');
        if (p) root.appendChild(renderPlanCard(p));
    } catch (e) { console.warn('weekly plan skipped', e); }

    if (tournamentMode) {
        const checklist = el('div', { class: 'card', style: { borderLeft: '3px solid var(--accent)' } });
        checklist.appendChild(el('h4', {}, [`Tournament window — ${daysToT === 0 ? 'today' : daysToT + ' days'} to ${nextT.name}`]));
        checklist.appendChild(el('p', { class: 'kicker' }, ['night before']));
        for (const item of TOURNAMENT_NIGHT_BEFORE) {
            const id = 'nb_' + item.replace(/\W+/g, '_');
            checklist.appendChild(el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', textTransform: 'none', letterSpacing: 'normal', fontFamily: 'var(--serif)', color: 'var(--cream)', marginBottom: '4px' } }, [
                el('input', { type: 'checkbox', id }), item
            ]));
        }
        checklist.appendChild(el('p', { class: 'kicker', style: { marginTop: '12px' } }, ['morning of']));
        for (const item of TOURNAMENT_MORNING_OF) {
            const id = 'mo_' + item.replace(/\W+/g, '_');
            checklist.appendChild(el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', textTransform: 'none', letterSpacing: 'normal', fontFamily: 'var(--serif)', color: 'var(--cream)', marginBottom: '4px' } }, [
                el('input', { type: 'checkbox', id }), item
            ]));
        }
        root.appendChild(checklist);
    }

    // === today's session card ===
    const card = el('div', { class: 'card' });
    root.appendChild(card);
    card.appendChild(el('h4', {}, ['Today']));

    // meditation
    const techSel = el('select', {}, [el('option', { value: '' }, ['—']), ...MEDITATION_TECHNIQUES.map((t) =>
        el('option', { value: t, selected: existing?.meditation_technique === t }, [t])
    )]);
    const techDur = el('input', { type: 'number', min: 0, max: 60, value: existing?.meditation_duration_min ?? '', placeholder: 'min' });
    const techFocus = scaleSlider({ value: existing?.meditation_focus_1_10 ?? 6 });

    card.appendChild(el('div', { class: 'row' }, [
        el('div', { class: 'field' }, [el('label', {}, ['Meditation']), techSel]),
        el('div', { class: 'field' }, [el('label', {}, ['Duration (min)']), techDur])
    ]));
    card.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Focus 1–10']), techFocus]));

    // simple toggles
    function toggleRow(id, label, defaultVal) {
        const cb = el('input', { type: 'checkbox', checked: !!defaultVal });
        const wrap = el('label', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', background: 'var(--ink-3)', color: '#f5f5f7', borderRadius: '8px', marginBottom: '6px', cursor: 'pointer' }
        }, [cb, el('span', {}, [label])]);
        wrap._cb = cb;
        return wrap;
    }
    const visToggle = toggleRow('vis', `Daily visualization rep (${profile.role === 'kaylan' ? '3' : '5'} min)`, existing?.visualization_done);
    const breathToggle = toggleRow('br', profile.role === 'raedyn' ? '4-7-8 breathing rehearsed' : 'Breathing rehearsed', existing?.breathing_done);
    const cueToggle = toggleRow('cue', 'In-bout cue practice', existing?.in_bout_cue_practice);
    card.appendChild(visToggle);
    card.appendChild(breathToggle);
    card.appendChild(cueToggle);

    // scenarios
    card.appendChild(el('div', { class: 'field', style: { marginTop: '14px' } }, [
        el('label', {}, ['Scenarios rehearsed']),
        chipGroup({
            options: SCENARIOS,
            selected: new Set(existing?.scenarios_rehearsed || []),
            onChange: () => {} // captured at save
        })
    ]));
    const scenarioWidget = card.lastChild.lastChild;

    // role-specific blocks
    let instinctEditor = null;
    let speedSlider = null;
    if (profile.role === 'raedyn') {
        card.appendChild(el('div', { class: 'field', style: { marginTop: '14px' } }, [
            el('label', {}, ['Instinct catalog — moves you reached for today (no thinking)'])
        ]));
        instinctEditor = chipArrayEditor({
            values: (existing?.instinct_catalog || []).map((x) => x.move || x),
            placeholder: 'add a move you defaulted to'
        });
        card.appendChild(instinctEditor);
    } else if (profile.role === 'kaylan') {
        card.appendChild(el('div', { class: 'field', style: { marginTop: '14px' } }, [
            el('label', {}, ['Speed self-rating (1–10)']),
            (speedSlider = scaleSlider({ value: existing?.speed_self_rating ?? 6 }))
        ]));
    }

    const notes = el('textarea', { placeholder: 'one or two sentences (optional)' }, [existing?.notes || '']);
    card.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Notes']), notes]));

    // === loss reflections (60-second rule) ===
    const losses = recentBouts.filter((b) => b.outcome === 'loss');
    if (losses.length) {
        const lossCard = el('div', { class: 'card', style: { borderLeft: '3px solid var(--danger)' } });
        lossCard.appendChild(el('h4', {}, ['Quick loss reflection · 60-second rule']));
        lossCard.appendChild(el('p', { class: 'kicker' }, ['one thing you\'d do differently — then move on']));
        const reflections = [...(existing?.loss_reflections || [])];
        for (const b of losses.slice(0, 3)) {
            const prior = reflections.find((r) => r.bout_id === b.id);
            const input = el('input', {
                type: 'text', placeholder: 'one thing…', value: prior?.one_thing || '',
                onchange: (e) => {
                    const idx = reflections.findIndex((r) => r.bout_id === b.id);
                    const entry = { bout_id: b.id, one_thing: e.target.value.trim() };
                    if (idx >= 0) reflections[idx] = entry; else reflections.push(entry);
                }
            });
            lossCard.appendChild(el('div', { class: 'field' }, [
                el('label', {}, [`vs ${b.opponent_name || '?'} · ${b.my_score}–${b.their_score} · ${fmtDate(b.date)}`]),
                input
            ]));
        }
        card._reflectionsRef = reflections;
        root.appendChild(lossCard);
    }

    root.appendChild(el('div', { class: 'btn-row right' }, [
        el('button', { class: 'btn', onclick: save }, ['Save today'])
    ]));

    async function save() {
        const scenariosSelected = Array.from(scenarioWidget.querySelectorAll('.chip[aria-pressed="true"]')).map((c) => c.dataset.slug);
        const payload = {
            profile_id: profile.id,
            date,
            meditation_technique: techSel.value || null,
            meditation_duration_min: techDur.value ? Number(techDur.value) : null,
            meditation_focus_1_10: techFocus.getValue(),
            visualization_done: visToggle._cb.checked,
            breathing_done: breathToggle._cb.checked,
            in_bout_cue_practice: cueToggle._cb.checked,
            scenarios_rehearsed: scenariosSelected,
            loss_reflections: card._reflectionsRef || existing?.loss_reflections || [],
            instinct_catalog: instinctEditor ? instinctEditor.getValues().map((m) => ({ move: m })) : (existing?.instinct_catalog || []),
            speed_self_rating: speedSlider ? speedSlider.getValue() : (existing?.speed_self_rating ?? null),
            notes: notes.value.trim() || null
        };
        try {
            await safeWrite({ table: 'mental_sessions', op: 'upsert', payload, onConflict: 'profile_id,date' });
            toast('Saved' + (navigator.onLine ? '' : ' (offline — will sync)'));
        } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    }
}
