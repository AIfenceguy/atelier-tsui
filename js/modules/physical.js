// Module 3.4 — Physical training (drill library version).
// Categorized drill picker replaces hardcoded plans.
// Daily template (Raedyn explosive / Kaylan balanced) is now a one-tap suggestion.

import { el, todayISO, fmtDate, daysUntil, toast } from '../lib/util.js';
import { activeProfile } from '../lib/state.js';
import {
    getPhysicalForDate, listPhysicalRecent, nextTournament,
    listDrillLibrary, addDrillToLibrary, listBouts, listOpponents
} from '../lib/db.js';
import { safeWrite } from '../lib/offline.js';
import { loadWeeklyPlan, renderPlanCard } from '../lib/weekly-plan.js';
import { scaleSlider } from '../lib/chips.js';
import { getWeaknessDrills } from '../lib/weakness-drills.js';

// The drill data carries emoji in its labels. Strip them at render time so the
// screen matches the rest of the site; the data is left as it is.
const noEmoji = (t) => String(t ?? '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/^\s+/, '');

// The drill data shouts: SECOND-INTENTION FAKE, COUNTER-ATTACKERS. All-caps in
// a serif italic reads thin and hard to scan; sentence case reads as a title.
// Only applied when the source is entirely upper case, so mixed-case names
// pass through untouched.
const titleCase = (t) => {
    const s = String(t ?? '').trim();
    if (!s || s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/(^|[\s(])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
};
import { STAGES, RATINGS, computeStage, listDrillSessions, logDrillSession, tagToSlug } from '../lib/drill-mastery.js';

const CATEGORIES = [
    { slug: 'explosive',    label: 'Explosive' },
    { slug: 'plyometric',   label: 'Plyometric' },
    { slug: 'strength',     label: 'Strength' },
    { slug: 'conditioning', label: 'Conditioning' },
    { slug: 'mobility',     label: 'Mobility' },
    { slug: 'footwork',     label: 'Footwork' },
    { slug: 'blade',        label: 'Blade' },
    { slug: 'core',         label: 'Core' },
    { slug: 'recovery',     label: 'Recovery' }
];

const RAEDYN_TEMPLATE_BY_DOW = {
    1: ['broad-jumps', 'depth-jumps', 'core-circuit', 'footwork-ladder'],
    2: ['weapon-arm-circuit', 'mobility-flow'],
    3: ['single-leg-bounds', 'core-circuit', 'footwork-ladder'],
    4: ['sprint-intervals'],
    5: ['broad-jumps', 'depth-jumps', 'core-circuit', 'footwork-ladder'],
    6: ['weapon-arm-circuit', 'mobility-flow'],
    0: ['active-recovery']
};
const KAYLAN_TEMPLATE_BY_DOW = {
    1: ['animal-movements', 'footwork-ladder'],
    2: ['free-play'],
    3: ['plank-circuit', 'footwork-ladder'],
    4: ['free-play'],
    5: ['animal-movements'],
    6: ['free-play'],
    0: ['full-rest']
};
function templateSlugsFor(role, dow) {
    const tpl = role === 'raedyn' ? RAEDYN_TEMPLATE_BY_DOW
              : role === 'kaylan' ? KAYLAN_TEMPLATE_BY_DOW
              : null;
    if (!tpl) return [];
    const baseDaily = role === 'raedyn' ? ['jump-squats']
                    : role === 'kaylan' ? ['jump-squats', 'mobility-flow']
                    : [];
    return [...baseDaily, ...(tpl[dow] || [])];
}

export async function mountPhysical(root) {
    const profile = activeProfile();
    if (!profile) return root.appendChild(el('div', { class: 'empty' }, ['Pick a profile.']));

    const date = todayISO();
    const [existing, recent, nextT, library] = await Promise.all([
        getPhysicalForDate(date),
        listPhysicalRecent(14),
        nextTournament(),
        listDrillLibrary()
    ]);

    const libBySlug = new Map(library.map((d) => [d.slug, d]));

    const daysToT = nextT ? daysUntil(nextT.start_date) : null;
    const inTaper = daysToT != null && daysToT >= 0 && daysToT <= 5;

    const session = (existing?.drills_completed || []).map((d) => {
        const lib = libBySlug.get(d.drill_slug);
        return {
            drill_slug: d.drill_slug,
            label: d.label || lib?.label || d.drill_slug,
            category: d.category || lib?.category || 'other',
            target_reps: d.target_reps ?? lib?.default_reps ?? 0,
            sets: d.sets ?? lib?.default_sets ?? 1,
            actual_reps: d.actual_reps || 0,
            done: !!d.done
        };
    });

    root.appendChild(el('div', { style: { padding: '40px var(--gut) 8px' } }, [
        el('h1', { class: 'page-eyebrow' }, ['Body']),
        el('div', { class: 'today-sub' }, [
            el('span', {}, [profile.name.toUpperCase()]),
            el('span', {}, [fmtDate(date).toUpperCase()])
        ])
    ]));

    // This week's one thing for the body, from his own data, with the tick.
    try {
        const plans = await loadWeeklyPlan(profile);
        const p = plans.find((x) => x.area === 'body');
        if (p) root.appendChild(renderPlanCard(p));
    } catch (e) { console.warn('weekly plan skipped', e); }

    if (inTaper) {
        root.appendChild(el('div', { class: 'card', style: { margin: '0 var(--gut) 16px' } }, [
            el('div', { class: 'label', style: { color: 'var(--gold)' } }, [`Taper · ${daysToT === 0 ? 'today' : daysToT + ' days'} to ${nextT.name}`]),
            el('p', { style: { fontSize: '14px', margin: '8px 0 0' } }, ['Plyometric volume reduced ~50% as a guideline. Skip anything that feels heavy in the legs.'])
        ]));
    }
    const kneeHits = recent.filter((s) => s.injury_flag && /knee/i.test(s.soreness_location || '')).length;
    if (kneeHits >= 3) {
        root.appendChild(el('div', { class: 'card', style: { margin: '0 var(--gut) 16px' } }, [
            el('div', { class: 'label', style: { color: 'var(--loss)' } }, [`Knee soreness flagged ${kneeHits}× in last 14 days`]),
            el('p', { style: { fontSize: '14px', margin: '8px 0 0' } }, ['Rising knee pain during plyo work is worth a check-in. Advisory only — talk to your coach.'])
        ]));
    }

    // ── Weak-Spot Training (prescriptive drills for this fencer's known weaknesses) ──
    const weaknesses = getWeaknessDrills(profile.role);
    if (weaknesses.length) {
        root.appendChild(buildWeaknessPanel(profile, weaknesses));
    }

    const sessionSection = el('div', { style: { padding: '0 var(--gut)' } });
    root.appendChild(el('div', { class: 'label-row' }, [
        el('span', { class: 'label' }, ["Today's session"]),
        el('button', {
            type: 'button', class: 'btn btn-ghost btn-sm',
            style: { fontSize: '12px' },
            onclick: () => {
                const dow = new Date(date + 'T00:00:00').getDay();
                const slugs = templateSlugsFor(profile.role, dow);
                let added = 0;
                for (const slug of slugs) {
                    if (session.find((s) => s.drill_slug === slug)) continue;
                    const lib = libBySlug.get(slug);
                    if (!lib) continue;
                    session.push({
                        drill_slug: lib.slug,
                        label: lib.label,
                        category: lib.category,
                        target_reps: lib.default_reps || 0,
                        sets: lib.default_sets || 1,
                        actual_reps: 0,
                        done: false
                    });
                    added++;
                }
                if (added) toast(`Loaded ${added} drill${added === 1 ? '' : 's'} from today's template`);
                else toast('Already loaded');
                renderSession();
            }
        }, ['Load today\'s template'])
    ]));
    root.appendChild(sessionSection);

    function renderSession() {
        sessionSection.innerHTML = '';
        if (!session.length) {
            sessionSection.appendChild(el('p', {
                style: { color: 'var(--ink-mute)', fontStyle: 'italic', padding: '12px 0' }
            }, ['No drills yet. Pick a category below to add some.']));
            return;
        }
        for (const d of session) {
            sessionSection.appendChild(buildSessionRow(d));
        }
    }

    function buildSessionRow(d) {
        const idx = session.indexOf(d);
        const repsInput = el('input', {
            type: 'number', min: 0, value: d.actual_reps || 0,
            class: 'field-input field-numeric',
            style: { textAlign: 'right', maxWidth: '72px' },
            onchange: (e) => {
                d.actual_reps = Number(e.target.value) || 0;
                d.done = d.actual_reps >= d.target_reps && d.target_reps > 0;
                row.classList.toggle('is-done', d.done);
            }
        });
        const setsInput = el('input', {
            type: 'number', min: 0, value: d.sets || 1,
            class: 'field-input field-numeric',
            style: { textAlign: 'right', maxWidth: '52px' },
            onchange: (e) => { d.sets = Number(e.target.value) || 1; }
        });
        const row = el('div', {
            class: 'drill' + (d.done ? ' is-done' : ''),
            style: {
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '14px 0', borderBottom: '1px solid var(--rule)'
            }
        }, [
            el('button', {
                type: 'button',
                style: {
                    width: '24px', height: '24px', borderRadius: '6px',
                    border: '1.5px solid var(--rule-strong)',
                    background: d.done ? 'var(--cta, #0071e3)' : 'transparent',
                    color: d.done ? '#fff' : 'transparent',
                    cursor: 'pointer', flexShrink: 0
                },
                onclick: () => {
                    d.done = !d.done;
                    if (d.done && (!d.actual_reps || d.actual_reps < d.target_reps)) {
                        d.actual_reps = d.target_reps;
                        repsInput.value = d.target_reps;
                    }
                    renderSession();
                }
            }, [d.done ? '' : '']),
            el('div', { style: { flex: '1 1 auto', minWidth: 0 } }, [
                el('div', { style: { fontWeight: 500, fontSize: '15px' } }, [d.label]),
                el('div', {
                    style: { fontSize: '11px', color: 'var(--ink-mute)', textTransform: 'uppercase', letterSpacing: '0.04em' }
                }, [
                    d.category,
                    d.target_reps ? ` · target ${d.target_reps}` : '',
                    d.sets > 1 ? ` × ${d.sets}` : ''
                ])
            ]),
            el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px', color: 'var(--ink-mute)' } }, [
                el('span', {}, ['reps']),
                repsInput,
                el('span', {}, ['sets']),
                setsInput
            ]),
            el('button', {
                type: 'button',
                style: {
                    border: 'none', background: 'transparent', color: 'var(--loss)',
                    cursor: 'pointer', fontSize: '18px', padding: '4px 8px'
                },
                onclick: () => { session.splice(idx, 1); renderSession(); }
            }, ['×'])
        ]);
        return row;
    }

    renderSession();

    root.appendChild(el('div', { class: 'label-row', style: { marginTop: '32px' } }, [
        el('span', { class: 'label' }, ['Add a drill'])
    ]));

    let activeCat = CATEGORIES[0].slug;

    const catRow = el('div', { class: 'chip-row', style: { padding: '0 var(--gut) 8px', flexWrap: 'wrap' } });
    function renderCatRow() {
        catRow.innerHTML = '';
        for (const c of CATEGORIES) {
            catRow.appendChild(el('button', {
                type: 'button',
                class: 'chip' + (c.slug === activeCat ? ' active selected' : ''),
                onclick: () => { activeCat = c.slug; renderCatRow(); renderDrillList(); }
            }, [c.label]));
        }
    }
    root.appendChild(catRow);
    renderCatRow();

    const drillList = el('div', { style: { padding: '4px var(--gut) 16px' } });
    root.appendChild(drillList);

    function renderDrillList() {
        drillList.innerHTML = '';
        const drills = library.filter((d) => d.category === activeCat);
        if (!drills.length) {
            drillList.appendChild(el('p', { style: { color: 'var(--ink-mute)', fontStyle: 'italic' } }, ['No drills in this category yet.']));
        }
        for (const d of drills) {
            const inSession = session.find((s) => s.drill_slug === d.slug);
            drillList.appendChild(el('div', {
                style: {
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 0', borderBottom: '1px solid var(--rule)'
                }
            }, [
                el('div', { style: { flex: '1 1 auto', minWidth: 0 } }, [
                    el('div', { style: { fontWeight: 500, fontSize: '15px' } }, [d.label]),
                    el('div', {
                        style: { fontSize: '12px', color: 'var(--ink-mute)', marginTop: '2px' }
                    }, [d.notes || `${d.default_reps || ''} reps${d.default_sets > 1 ? ' × ' + d.default_sets + ' sets' : ''}`])
                ]),
                el('button', {
                    type: 'button',
                    class: inSession ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm',
                    style: { fontSize: '12px', padding: '6px 14px' },
                    disabled: !!inSession,
                    onclick: () => {
                        if (inSession) return;
                        session.push({
                            drill_slug: d.slug,
                            label: d.label,
                            category: d.category,
                            target_reps: d.default_reps || 0,
                            sets: d.default_sets || 1,
                            actual_reps: 0,
                            done: false
                        });
                        renderSession();
                        renderDrillList();
                    }
                }, [inSession ? 'Added' : '+ Add'])
            ]));
        }

        const newForm = el('div', { style: { marginTop: '14px', padding: '14px', background: 'var(--surface-2)', borderRadius: '12px' } });
        const newLabel = el('input', { type: 'text', class: 'field-input', placeholder: 'Drill name — e.g. "Push-up" or "Box jumps"', style: { width: '100%', marginBottom: '8px', background: '#fff', color: '#1a1a1a', border: '1px solid #d9d9dc', borderRadius: '8px', padding: '10px 12px' } });
        const newReps = el('input', { type: 'number', class: 'field-input field-numeric', placeholder: '20', min: 0, style: { maxWidth: '90px', background: '#fff', color: '#1a1a1a', border: '1px solid #d9d9dc', borderRadius: '8px', padding: '10px 12px', textAlign: 'center' } });
        const newSets = el('input', { type: 'number', class: 'field-input field-numeric', placeholder: '3', min: 1, value: 1, style: { maxWidth: '70px', background: '#fff', color: '#1a1a1a', border: '1px solid #d9d9dc', borderRadius: '8px', padding: '10px 12px', textAlign: 'center' } });
        const newNotes = el('input', { type: 'text', class: 'field-input', placeholder: 'Tip — e.g. "60s rest" or "slow tempo"', style: { flex: 1, background: '#fff', color: '#1a1a1a', border: '1px solid #d9d9dc', borderRadius: '8px', padding: '10px 12px' } });
        newForm.appendChild(el('div', { style: { fontSize: '12px', color: 'var(--ink-mute)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.04em' } }, [`New drill — ${CATEGORIES.find((c) => c.slug === activeCat)?.label}`]));
        newForm.appendChild(newLabel);
        newForm.appendChild(el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' } }, [
            newReps, newSets, newNotes,
            el('button', {
                type: 'button', class: 'btn btn-primary btn-sm', style: { fontSize: '12px' },
                onclick: async () => {
                    const label = newLabel.value.trim();
                    if (!label) { toast('Drill name required', 'error'); return; }
                    try {
                        const created = await addDrillToLibrary({
                            category: activeCat,
                            label,
                            default_reps: Number(newReps.value) || 0,
                            default_sets: Number(newSets.value) || 1,
                            default_rest_s: null,
                            notes: newNotes.value.trim() || null
                        });
                        library.push(created);
                        libBySlug.set(created.slug, created);
                        session.push({
                            drill_slug: created.slug,
                            label: created.label,
                            category: created.category,
                            target_reps: created.default_reps || 0,
                            sets: created.default_sets || 1,
                            actual_reps: 0,
                            done: false
                        });
                        toast(`Added "${created.label}" to library`);
                        renderSession();
                        renderDrillList();
                    } catch (e) {
                        toast('Could not add: ' + e.message, 'error');
                    }
                }
            }, ['Save'])
        ]));
        drillList.appendChild(newForm);
    }
    renderDrillList();

    const energy = scaleSlider({ value: existing?.energy_1_10 ?? 7 });
    const sore = scaleSlider({ value: existing?.soreness_severity ?? 0, min: 0 });
    const sleep = el('input', { type: 'number', class: 'field-input field-numeric', step: '0.5', min: 0, max: 14, value: existing?.sleep_hours ?? '', placeholder: 'hours' });
    const soreLoc = el('input', { type: 'text', class: 'field-input', value: existing?.soreness_location || '', placeholder: 'where (optional)' });
    const injuryFlag = el('input', { type: 'checkbox', checked: !!existing?.injury_flag });
    const injuryNotes = el('textarea', { class: 'field-textarea', rows: 3, placeholder: "what's going on (optional)" }, [existing?.injury_notes || '']);

    root.appendChild(el('div', { class: 'label-row', style: { marginTop: '32px' } }, [
        el('span', { class: 'label' }, ["Today's body"])
    ]));
    root.appendChild(el('div', { style: { padding: '0 var(--gut)' } }, [
        el('div', { class: 'field' }, [el('label', { class: 'field-label' }, ['Energy 1–10']), energy]),
        el('div', { class: 'field' }, [el('label', { class: 'field-label' }, ['Soreness 0–10']), sore]),
        el('div', { class: 'field' }, [el('label', { class: 'field-label' }, ['Soreness — where']), soreLoc]),
        el('div', { class: 'field' }, [el('label', { class: 'field-label' }, ['Sleep last night (hrs)']), sleep]),
        el('div', { class: 'field' }, [
            el('label', { style: { display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' } }, [
                injuryFlag,
                el('span', { class: 'field-label', style: { letterSpacing: '0.18em' } }, ['Flag as injury day'])
            ])
        ]),
        el('div', { class: 'field' }, [el('label', { class: 'field-label' }, ['Injury notes']), injuryNotes])
    ]));

    root.appendChild(el('div', { style: { padding: '20px var(--gut) 16px' } }, [
        el('button', {
            class: 'btn btn-primary btn-mono-label',
            style: { width: '100%' },
            onclick: save
        }, ['Save today'])
    ]));

    if (recent.length) {
        root.appendChild(el('div', { class: 'label-row', style: { marginTop: '24px' } }, [
            el('span', { class: 'label' }, ['Last 14 days']),
            el('span', { class: 'label', style: { color: 'var(--ink-faint)' } }, [`${recent.length} SESSION${recent.length === 1 ? '' : 'S'}`])
        ]));
        root.appendChild(el('div', { class: 'chip-row', style: { padding: '0 var(--gut) 24px' } }, recent.map((s) =>
            el('span', {
                class: 'chip ' + (s.injury_flag ? '' : 'is-on'),
                style: s.injury_flag ? { color: 'var(--loss)' } : {}
            }, [
                fmtDate(s.date), ' · ', `${(s.drills_completed || []).length} drill${(s.drills_completed || []).length === 1 ? '' : 's'}`
            ])
        )));
    }

    async function save() {
        const drillsCompleted = session.map((d) => ({
            drill_slug: d.drill_slug,
            label: d.label,
            category: d.category,
            target_reps: d.target_reps,
            sets: d.sets,
            actual_reps: d.actual_reps || 0,
            done: !!d.done
        }));
        const payload = {
            profile_id: profile.id,
            date,
            drills_completed: drillsCompleted,
            energy_1_10: energy.getValue(),
            soreness_location: soreLoc.value.trim() || null,
            soreness_severity: sore.getValue(),
            sleep_hours: sleep.value ? Number(sleep.value) : null,
            injury_flag: !!injuryFlag.checked,
            injury_notes: injuryNotes.value.trim() || null
        };
        try {
            await safeWrite({ table: 'physical_sessions', op: 'upsert', payload, onConflict: 'profile_id,date' });
            toast('Saved' + (navigator.onLine ? '' : ' (offline — will sync)'));
        } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    }

    // Weakness panel hooks into the live `session` array so "Add to today" works.
    function buildWeaknessPanel(profile, weaknesses) {
        const panel = el('section', { class: 'weak-panel', style: { margin: '0 var(--gut) 18px' } });
        panel.appendChild(el('div', { class: 'weak-head' }, [
            el('span', { class: 'weak-eyebrow' }, ['WEAK-SPOT TRAINING']),
            el('span', { class: 'weak-sub' }, [`Drills tuned to what beats ${profile.name.split(' ')[0]}.`])
        ]));

        for (const w of weaknesses) {
            const card = el('article', { class: 'weak-card', 'data-slug': w.slug }, [
                el('header', { class: 'weak-card-head' }, [
                    el('span', { class: 'weak-card-title' }, [titleCase(noEmoji(w.label))]),
                    el('span', { class: 'weak-card-record', 'data-role': 'record' }, ['—'])
                ]),
                el('p', { class: 'weak-card-why' }, [w.why_it_hurts]),
                buildPlaySection('TECHNIQUE & DRILLS', w.technique, w, 'technique'),
                buildPlaySection('BODY TRAINING', w.body, w, 'body')
            ]);
            panel.appendChild(card);
        }

        // Async — compute live signals from bouts vs opponent archetypes + drill dose
        (async () => {
            try {
                const [allBouts, allOpps, recent14] = await Promise.all([
                    listBouts({ limit: 80 }),
                    listOpponents(),
                    listPhysicalRecent(14)
                ]);
                const oppById = new Map(allOpps.map(o => [o.id, o]));
                const cutoff = new Date(Date.now() - 60 * 86400000);
                for (const w of weaknesses) {
                    let wins = 0, losses = 0;
                    for (const b of allBouts) {
                        if (!b.date || !b.outcome) continue;
                        if (new Date(b.date) < cutoff) continue;
                        const o = oppById.get(b.opponent_id);
                        if (!o || !Array.isArray(o.archetypes)) continue;
                        if (!o.archetypes.includes(w.slug)) continue;
                        if (b.outcome === 'win') wins++;
                        else if (b.outcome === 'loss') losses++;
                    }
                    const recEl = panel.querySelector(`[data-slug="${w.slug}"] [data-role="record"]`);
                    if (recEl) {
                        if (wins + losses === 0) {
                            recEl.textContent = 'No bouts tagged yet — tag opponents to track';
                            recEl.classList.add('weak-empty');
                        } else {
                            const pct = Math.round((wins / (wins + losses)) * 100);
                            recEl.textContent = `Last 60d: ${wins}-${losses} (${pct}%)`;
                            recEl.classList.toggle('weak-urgent', wins + losses >= 3 && pct < 50);
                        }
                    }
                }
                panel.querySelectorAll('[data-add-slug]').forEach(btn => {
                    const slug = btn.getAttribute('data-add-slug');
                    const lib = libBySlug.get(slug);
                    if (!lib) {
                        btn.disabled = true;
                        btn.textContent = '(no library match)';
                        btn.classList.add('weak-add-missing');
                        return;
                    }
                    btn.addEventListener('click', () => {
                        if (session.find(s => s.drill_slug === slug)) {
                            toast('Already in today’s session');
                            return;
                        }
                        session.push({
                            drill_slug: lib.slug,
                            label: lib.label,
                            category: lib.category,
                            target_reps: lib.default_reps || 0,
                            sets: lib.default_sets || 1,
                            actual_reps: 0,
                            done: false
                        });
                        renderSession();
                        toast(`Added ${lib.label} to today`);
                        btn.textContent = 'Added';
                        btn.disabled = true;
                    });
                });
                panel.querySelectorAll('[data-dose-slug]').forEach(pill => {
                    const slug = pill.getAttribute('data-dose-slug');
                    let count = 0;
                    for (const s of recent14) {
                        if (!Array.isArray(s.drills_completed)) continue;
                        if (s.drills_completed.some(d => d.drill_slug === slug && d.done)) count++;
                    }
                    pill.textContent = count ? `DONE ${count}× / 14d` : 'NOT DONE THIS WEEK';
                    pill.classList.toggle('weak-dose-cold', count === 0);
                    pill.classList.toggle('weak-dose-warm', count > 0 && count < 3);
                    pill.classList.toggle('weak-dose-hot', count >= 3);
                });
            } catch (e) {
                console.warn('[weakness] signal load failed:', e);
            }
        })();

        // Mastery badges — paint async
        refreshMasteryBadges(profile, panel);

        return panel;
    }

    function buildPlaySection(label, plays, w, kind) {
        if (!plays || !plays.length) return el('div', {}, []);
        return el('div', { class: 'weak-section' }, [
            el('div', { class: 'weak-section-label' }, [label]),
            ...plays.map(p => {
                const drillSlug = tagToSlug(p.tag);
                return el('div', { class: `weak-play weak-play-p${p.priority || 3}`, 'data-drill-slug': drillSlug, 'data-weakness-slug': w.slug }, [
                    el('div', { class: 'weak-play-head' }, [
                        el('span', { class: 'weak-play-tag' }, [titleCase(noEmoji(p.tag))]),
                        // Mastery badge — populated async in buildWeaknessPanel
                        el('span', { class: 'mastery-badge', 'data-mastery-slug': drillSlug }, ['New']),
                        p.add_drill ? el('span', { class: 'weak-dose-pill', 'data-dose-slug': p.add_drill }, ['—']) : null
                    ].filter(Boolean)),
                    p.data ? el('div', { class: 'weak-play-data' }, [p.data]) : null,
                    el('div', { class: 'weak-play-row' }, [
                        el('span', { class: 'weak-play-label' }, ['GAME PLAN']),
                        el('p', { class: 'weak-play-text' }, [p.game_plan])
                    ]),
                    el('div', { class: 'weak-play-row weak-play-cue' }, [
                        el('span', { class: 'weak-play-label' }, [kind === 'body' ? 'CUE' : 'IN-LESSON CUE']),
                        el('p', { class: 'weak-play-text' }, [p.cue])
                    ]),
                    el('div', { class: 'weak-play-actions' }, [
                        el('button', {
                            type: 'button',
                            class: 'weak-link-btn',
                            onclick: () => openLogModal(p, w, drillSlug)
                        }, ['+ Log a rep']),
                        p.add_drill ? el('button', {
                            type: 'button',
                            class: 'weak-add-btn',
                            'data-add-slug': p.add_drill
                        }, ['+ Add to today']) : null
                    ].filter(Boolean))
                ]);
            })
        ]);
    }

    // ─── Drill mastery rendering: paint badges from drill_sessions on load ───
    async function refreshMasteryBadges(profile, root) {
        try {
            const sessions = await listDrillSessions(profile.id, { sinceDays: 60 });
            const byDrill = new Map();
            for (const s of sessions) {
                if (!byDrill.has(s.drill_slug)) byDrill.set(s.drill_slug, []);
                byDrill.get(s.drill_slug).push(s);
            }
            const badges = root.querySelectorAll('.mastery-badge');
            for (const b of badges) {
                const slug = b.getAttribute('data-mastery-slug');
                const sList = byDrill.get(slug) || [];
                const stage = computeStage(sList);
                b.textContent = `${stage.emoji} ${stage.label.toUpperCase()}`;
                // Stage colors: dim → green-outline → green-filled → gold-outline → gold-filled
                const palettes = [
                    'background:rgba(107,114,128,0.12);color:#6B7280;',
                    'background:rgba(34,139,34,0.10);color:#1f7a1f;border:1px solid #1f7a1f;',
                    'background:rgba(34,139,34,0.18);color:#fff;',
                    'background:rgba(212,160,23,0.15);color:#8a5a07;border:1px solid #8a5a07;',
                    'background:linear-gradient(180deg,#d4a017,#a37410);color:#fff;'
                ];
                const baseStyle = 'display:inline-block;margin-left:8px;padding:2px 8px;font-family:var(--eg-mono,monospace);font-size:10px;font-weight:700;letter-spacing:0.06em;border-radius:999px;';
                b.setAttribute('style', baseStyle + palettes[stage.idx]);
                b.setAttribute('title', stage.blurb);
            }
        } catch (e) { console.warn('[mastery] badge refresh failed', e); }
    }

    // ─── Log-a-rep modal ───
    function openLogModal(play, weakness, drillSlug) {
        const sheet = el('div', { class: 'td-sheet-bg', onclick: (e) => { if (e.target.classList.contains('td-sheet-bg')) close(); } });
        const sheetInner = el('div', { class: 'td-sheet', style: 'max-width:480px;' });
        let reps = 10, rating = 3;
        const repsLabel = el('span', { style: 'font-family:var(--eg-mono,monospace);font-size:20px;font-weight:700;' }, [String(reps)]);
        function setReps(n) { reps = Math.max(0, Math.min(99, n)); repsLabel.textContent = String(reps); }
        const ratingRow = el('div', { style: 'display:flex;gap:6px;justify-content:center;margin:12px 0;' });
        function paintRating() {
            ratingRow.querySelectorAll('button[data-rating]').forEach(b => {
                const v = +b.getAttribute('data-rating');
                b.style.background = v === rating ? 'rgba(43,107,255,0.18)' : 'transparent';
                b.style.border = v === rating ? '2px solid #2B6BFF' : '2px solid rgba(0,0,0,0.08)';
            });
        }
        for (const r of RATINGS) {
            const btn = el('button', {
                type: 'button',
                'data-rating': String(r.val),
                style: 'background:transparent;border:2px solid rgba(0,0,0,0.08);border-radius:10px;padding:8px 6px;cursor:pointer;min-width:54px;font-size:20px;',
                onclick: () => { rating = r.val; paintRating(); }
            }, [
                el('div', {}, [r.emoji]),
                el('div', { style: 'font-size:9px;font-family:var(--eg-mono,monospace);text-transform:uppercase;letter-spacing:0.04em;color:#6B7280;margin-top:2px;' }, [r.label])
            ]);
            ratingRow.appendChild(btn);
        }
        const noteInput = el('input', { type: 'text', placeholder: 'note (optional)', style: 'width:100%;padding:8px;border:1px solid rgba(0,0,0,0.12);border-radius:6px;font-size:14px;' });

        sheetInner.appendChild(el('div', { class: 'td-sheet-head' }, [
            el('span', { class: 'td-sheet-eye' }, ['+ LOG A REP']),
            el('button', { type: 'button', class: 'td-sheet-x', onclick: close }, ['×'])
        ]));
        sheetInner.appendChild(el('div', { style: 'text-align:center;font-size:13px;color:#1A1D24;margin:4px 0 12px;' }, [play.tag]));
        sheetInner.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:center;gap:12px;margin:8px 0;' }, [
            el('button', { type: 'button', style: 'width:42px;height:42px;border-radius:50%;border:1px solid rgba(0,0,0,0.12);background:#fff;font-size:20px;cursor:pointer;', onclick: () => setReps(reps - 1) }, ['−']),
            el('div', { style: 'min-width:80px;text-align:center;' }, [
                repsLabel,
                el('div', { style: 'font-size:10px;font-family:var(--eg-mono,monospace);text-transform:uppercase;letter-spacing:0.08em;color:#6B7280;' }, ['reps'])
            ]),
            el('button', { type: 'button', style: 'width:42px;height:42px;border-radius:50%;border:1px solid rgba(0,0,0,0.12);background:#fff;font-size:20px;cursor:pointer;', onclick: () => setReps(reps + 1) }, ['+']),
            el('button', { type: 'button', style: 'padding:4px 12px;border-radius:6px;border:1px solid rgba(0,0,0,0.12);background:#fff;font-size:11px;font-family:var(--eg-mono,monospace);text-transform:uppercase;letter-spacing:0.06em;cursor:pointer;', onclick: () => setReps(reps + 5) }, ['+5']),
            el('button', { type: 'button', style: 'padding:4px 12px;border-radius:6px;border:1px solid rgba(0,0,0,0.12);background:#fff;font-size:11px;font-family:var(--eg-mono,monospace);text-transform:uppercase;letter-spacing:0.06em;cursor:pointer;', onclick: () => setReps(reps + 10) }, ['+10'])
        ]));
        sheetInner.appendChild(el('div', { style: 'text-align:center;font-size:11px;font-family:var(--eg-mono,monospace);text-transform:uppercase;letter-spacing:0.08em;color:#6B7280;margin:8px 0 4px;' }, ['quality']));
        sheetInner.appendChild(ratingRow);
        sheetInner.appendChild(noteInput);
        sheetInner.appendChild(el('div', { class: 'td-sheet-actions' }, [
            el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, ['Cancel']),
            el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
                try {
                    await logDrillSession({
                        profileId: profile.id,
                        drillSlug,
                        weaknessSlug: weakness.slug,
                        reps,
                        rating,
                        note: noteInput.value || null
                    });
                    toast('Session logged');
                    close();
                    refreshMasteryBadges(profile, document);
                } catch (e) {
                    console.warn('log fail', e);
                    toast('Save failed — try again', 'error');
                }
            } }, ['Save'])
        ]));
        sheet.appendChild(sheetInner);
        document.body.appendChild(sheet);
        paintRating();
        function close() { sheet.remove(); }
    }
}
