// Bouts (Free Fence) — list, entry form, detail.
// Visual layer per the new design: editorial bout-card timeline,
// stripped form with field-row labels and chip-row tactics.

import { el, todayISO, fmtDate, fmtDateLong, toast } from '../lib/util.js';
import { quickBout } from '../lib/quick-bout.js';
import { go } from '../lib/router.js';
import { supa } from '../lib/supa.js';
import { activeProfile } from '../lib/state.js';
import { listBouts, getBout, listOpponents, findOrCreateOpponent, loadTaxonomies } from '../lib/db.js';
import { chipGroup, tacticTally, concededTally } from '../lib/chips.js';
import { safeWrite } from '../lib/offline.js';
import { loadWeeklyPlan, renderPlanCard } from '../lib/weekly-plan.js';
import { boutDebrief, listCoachNotes } from '../lib/coach.js';
import { getWeaknessDrills } from '../lib/weakness-drills.js';
import { logDrillSession, tagToSlug } from '../lib/drill-mastery.js';
import { loadLostBouts, renderLostBoutsCard, seedFromResult, recentResultOpponents, factsForName } from '../lib/lost-bouts.js';

const CONTEXT_OPTIONS = [
    { value: 'club_open', label: 'Club open fencing' },
    { value: 'tournament_prep', label: 'Tournament prep' },
    { value: 'pool', label: 'Tournament pool' },
    { value: 'de', label: 'Tournament DE' },
    { value: 'other', label: 'Other' }
];

// =====================================================
// LIST — editorial timeline of bout-card rows
// =====================================================
export async function mountBoutsList(root) {
    const profile = activeProfile();
    if (!profile) {
        root.appendChild(el('div', { class: 'empty' }, [
            el('p', { class: 'empty-line' }, ['Pick a profile to log bouts.'])
        ]));
        return;
    }

    root.appendChild(el('div', { style: { padding: '40px var(--gut) 8px' } }, [
        el('h1', { class: 'page-eyebrow' }, ['Free Fence']),
        el('div', { class: 'today-sub' }, [
            el('span', {}, [profile.name.toUpperCase()])
        ])
    ]));

    // This week's one thing for bouts, from his own record, with the tick.
    try {
        const plans = await loadWeeklyPlan(profile);
        const p = plans.find((x) => x.area === 'bout');
        if (p) root.appendChild(renderPlanCard(p));
    } catch (e) { console.warn('weekly plan skipped', e); }

    // Above the list and above the empty state: the empty state is precisely
    // when a two-tap log matters most.
    root.appendChild(quickBout({
        profile,
        onSaved: () => { root.innerHTML = ''; mountBoutsList(root); }
    }));

    // Competition losses the results already know about, waiting for his
    // side of the story. Also links what he logged by hand to the results.
    try {
        const lost = await loadLostBouts(profile);
        const card = renderLostBoutsCard(profile, lost);
        if (card) root.appendChild(card);
    } catch (e) { console.warn('lost bouts skipped', e); }

    let bouts = [];
    try {
        bouts = await listBouts({ limit: 50 });
    } catch (e) {
        root.appendChild(el('div', { class: 'card', style: { color: 'var(--loss)', margin: '0 var(--gut)' } }, [`Failed to load bouts: ${e.message}`]));
        return;
    }

    if (!bouts.length) {
        root.appendChild(el('div', { class: 'empty' }, [
            el('p', { class: 'empty-line' }, ['No bouts logged yet. Score one above and it opens the journal.'])
        ]));
        return;
    }

    for (const b of bouts) {
        root.appendChild(boutCard(b));
    }
}

// Render a single bout as the editorial card with sparkline + quote
function boutCard(b) {
    const my = b.my_score ?? 0;
    const their = b.their_score ?? 0;
    const isWin = b.outcome === 'win';
    const isLoss = b.outcome === 'loss';

    const total = my + their;
    const ticks = [];
    for (let i = 0; i < total; i++) {
        ticks.push(el('span', { class: i < my ? 'touch-tick is-scored' : 'touch-tick' }));
    }
    const acts = Array.isArray(b.scoring_actions) ? b.scoring_actions : [];
    const lastAct = acts.length ? acts[acts.length - 1] : null;
    if (lastAct && /flick/i.test(lastAct.tactic_slug || '') && my > 0 && ticks[my - 1]) {
        ticks[my - 1] = el('span', { class: 'touch-tick is-flick' });
    }

    const tags = [];
    if (b.opponent_rating) tags.push(el('span', { class: 'bout-card-opp-tag' }, [b.opponent_rating]));
    (b.opponent_archetypes || []).forEach((a) => tags.push(el('span', { class: 'bout-card-opp-tag' }, [a])));
    if (b.opponent_club) tags.push(el('span', { class: 'bout-card-opp-tag' }, [b.opponent_club]));

    const meta = [];
    meta.push(el('span', {}, [fmtDate(b.date).toUpperCase()]));
    const ctxLabel = CONTEXT_OPTIONS.find((c) => c.value === b.context)?.label;
    if (ctxLabel) meta.push(el('span', {}, [ctxLabel.toUpperCase()]));
    if (b.location) meta.push(el('span', {}, [b.location.toUpperCase()]));
    // A quick-logged bout has a score and nothing else. Mark it so the promise
    // the quick form makes - score now, detail later - has somewhere to land.
    if (!acts.length && !b.reflection && !b.opponent_name) {
        meta.push(el('span', { style: { color: '#B45309', fontWeight: '700' } }, ['NEEDS DETAIL']));
    }

    return el('a', {
        href: `#bouts/show?id=${b.id}`,
        class: 'bout-card',
        style: { textDecoration: 'none', color: 'inherit', display: 'flex' }
    }, [
        el('div', { class: 'bout-card-head' }, [
            el('div', { class: 'bout-card-opp' }, [
                el('div', { class: 'bout-card-opp-name' }, [b.opponent_name || '—']),
                tags.length ? el('div', { class: 'bout-card-opp-tags' }, tags) : null
            ]),
            el('div', { style: { textAlign: 'right' } }, [
                el('div', { class: 'scoreline', style: { justifyContent: 'flex-end' } }, [
                    el('span', { class: `scoreline-num ${isWin ? 'is-win' : (isLoss ? 'is-loss' : '')}` }, [String(my)]),
                    el('span', { class: 'scoreline-sep' }, ['—']),
                    el('span', { class: 'scoreline-num' }, [String(their)])
                ]),
                ticks.length ? el('div', { class: 'touch-strip', style: { justifyContent: 'flex-end' } }, ticks) : null
            ])
        ]),
        b.reflection ? el('div', { class: 'bout-card-quote' }, [b.reflection]) : null,
        meta.length ? el('div', { class: 'bout-card-meta' }, meta) : null
    ]);
}

// =====================================================
// ENTRY (new + edit) — editorial form
// =====================================================
export async function mountBoutEntry(root, params) {
    const profile = activeProfile();
    if (!profile) {
        root.appendChild(el('div', { class: 'empty' }, [
            el('p', { class: 'empty-line' }, ['Pick a profile first.'])
        ]));
        return;
    }

    // Editing an existing bout, or starting from a result row (the facts
    // filled in, the reflection still his), or a blank form.
    const editingRow = params.id ? await getBout(params.id) : null;
    const seed = (!editingRow && params.from) ? await seedFromResult(params.from) : null;
    const editing = editingRow || seed;
    const taxos = await loadTaxonomies();
    const opponents = await listOpponents();

    const scoringOpts = taxos.tactics.filter((t) => t.kind === 'scoring');
    const failureOpts = taxos.tactics.filter((t) => t.kind === 'failure');

    root.appendChild(el('div', { style: { padding: '40px var(--gut) 8px' } }, [
        el('h1', { class: 'page-eyebrow' }, [editingRow ? 'Edit bout' : seed ? 'Log the loss' : 'Log a bout']),
        el('div', { class: 'today-sub' }, [
            el('span', {}, [profile.name.toUpperCase()])
        ])
    ]));
    if (seed) {
        root.appendChild(el('div', { class: 'card', style: { margin: '0 var(--gut) 8px' } }, [
            el('div', { class: 'label', style: { color: '#6B7280' } }, ['From the results']),
            el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '22px', color: 'var(--ink)', margin: '4px 0 4px' } }, [`${seed.my_score}–${seed.their_score} to ${seed.opponent_name}`]),
            el('p', { style: { color: '#6B7280', fontSize: '13px', margin: '0', lineHeight: '1.5' } }, [seed.fact + '. The facts are filled in below; add how the touches went and what you noticed.'])
        ]));
    }

    const form = el('form', {
        onsubmit: async (e) => {
            e.preventDefault();
            // Ignore re-entry while a save is in flight: a double-tap or a
            // stuck key produced four identical bouts in under a second.
            if (form.dataset.saving === '1') return;
            form.dataset.saving = '1';
            const submitBtn = form.querySelector('button[type="submit"]');
            if (submitBtn) submitBtn.disabled = true;
            try { await save(); }
            finally {
                delete form.dataset.saving;
                if (submitBtn) submitBtn.disabled = false;
            }
        },
        style: { padding: '0 var(--gut)' }
    });
    root.appendChild(form);
    // Carried from the result row, or from the bout being edited.
    form.appendChild(el('input', { type: 'hidden', name: 'opponent_tracker_id', value: editing?.opponent_tracker_id ? String(editing.opponent_tracker_id) : '' }));
    form.appendChild(el('input', { type: 'hidden', name: 'source_bout_id', value: editing?.source_bout_id || '' }));

    // SECTION: When / where
    form.appendChild(sectionLabel('When · where'));
    form.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label' }, ['Date']),
        el('input', { type: 'date', name: 'date', class: 'field-input', value: editing?.date || todayISO(), required: true })
    ]));

    // Context — chips, not select
    const ctxField = el('div', { class: 'field' }, [
        el('label', { class: 'field-label' }, ['Context'])
    ]);
    const ctxRow = el('div', { class: 'chip-row', style: { marginTop: '6px' } });
    let selectedCtx = editing?.context || 'club_open';
    const ctxBtns = CONTEXT_OPTIONS.map((opt) => {
        const btn = el('button', {
            type: 'button',
            class: 'chip' + (selectedCtx === opt.value ? ' is-on' : ''),
            'data-value': opt.value,
            onclick: (e) => {
                selectedCtx = opt.value;
                ctxRow.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-on', c.getAttribute('data-value') === opt.value));
            }
        }, [opt.label]);
        return btn;
    });
    ctxBtns.forEach((b) => ctxRow.appendChild(b));
    ctxField.appendChild(ctxRow);
    form.appendChild(ctxField);

    form.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label' }, ['Location']),
        el('input', { type: 'text', name: 'location', class: 'field-input', value: editing?.location || '', placeholder: 'club / venue' })
    ]));

    // SECTION: Opponent
    form.appendChild(sectionLabel('Opponent'));
    // Suggest everyone on record and everyone he met at a competition this
    // year. Rule of the house: a fact the results know is never typed.
    let resultOpps = [];
    try { resultOpps = await recentResultOpponents(profile); } catch (e) { console.warn('result opponents skipped', e); }
    const suggest = new Map();
    for (const o of opponents) suggest.set(o.name.toLowerCase(), o.name);
    for (const o of resultOpps) if (!suggest.has(o.name.toLowerCase())) suggest.set(o.name.toLowerCase(), o.name);
    const oppList = el('datalist', { id: 'opp-suggest' }, [...suggest.values()].sort().map((n) => el('option', { value: n }, [])));
    form.appendChild(oppList);
    const factLine = el('div', { class: 'label', style: { color: '#6B7280', marginTop: '4px' }, hidden: true });
    const oppNameInput = el('input', {
        type: 'text', name: 'opponent_name', class: 'field-input', list: 'opp-suggest',
        value: editing?.opponent_name || '',
        placeholder: 'who you fenced',
        required: true,
        autocomplete: 'off',
        onchange: async () => {
            const name = oppNameInput.value.trim();
            if (!name) return;
            try {
                const f = await factsForName(profile, name, resultOpps);
                if (!f) return;
                const rating = form.querySelector('input[name="opponent_rating"]');
                const club = form.querySelector('input[name="opponent_club"]');
                const tid = form.querySelector('input[name="opponent_tracker_id"]');
                if (rating && !rating.value && f.rating) rating.value = f.rating;
                if (club && !club.value && f.club) club.value = f.club;
                if (tid && !tid.value && f.tracker_id) tid.value = String(f.tracker_id);
                factLine.textContent = `From the results: ${f.name}${f.rating ? ` · ${f.rating}` : ''}${f.club ? ` · ${f.club}` : ''}${f.strength_de ? ` · strength ${f.strength_de}` : ''}`;
                factLine.hidden = false;
            } catch (e) { console.warn('name lookup failed', e); }
        }
    });
    form.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label' }, ['Name']),
        oppNameInput,
        factLine
    ]));
    form.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label' }, ['Rating']),
        el('input', { type: 'text', name: 'opponent_rating', class: 'field-input', value: editing?.opponent_rating || '', placeholder: 'U / E / D / C / B / A' })
    ]));
    form.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label' }, ['Club']),
        el('input', { type: 'text', name: 'opponent_club', class: 'field-input', value: editing?.opponent_club || '', placeholder: 'home club' })
    ]));

    // Assigned once the tally exists further down. Declared here so the tap
    // handler never touches scoringWidget before its initialiser has run -
    // even typeof throws on a const in the temporal dead zone.
    let refreshTally = null;
    let refreshConceded = null;

    // SECTION: Score — Roblox-style tap counter
    form.appendChild(sectionLabel('Score'));
    {
        const myInitial  = parseInt(editing?.my_score    ?? 0, 10) || 0;
        const themInitial= parseInt(editing?.their_score ?? 0, 10) || 0;
        const myInput    = el('input', { type: 'hidden', name: 'my_score',    value: String(myInitial) });
        const themInput  = el('input', { type: 'hidden', name: 'their_score', value: String(themInitial) });
        const myDisplay  = el('span', { class: 'tap-counter-num' }, [String(myInitial)]);
        const themDisplay= el('span', { class: 'tap-counter-num' }, [String(themInitial)]);
        const tap = (display, hidden, delta) => {
            const cur = (parseInt(hidden.value, 10) || 0) + delta;
            const clamped = Math.max(0, Math.min(30, cur));
            hidden.value = String(clamped);
            display.textContent = String(clamped);
            display.classList.remove('tap-counter-pop'); void display.offsetWidth; display.classList.add('tap-counter-pop');
            if (window.navigator && window.navigator.vibrate) window.navigator.vibrate(10);
            // The tally counts against this score, so it has to hear about it.
            if (refreshTally) refreshTally();
            if (refreshConceded) refreshConceded();
        };
        const buildCounter = (label, kind, hidden, display) => el('div', { class: 'tap-counter ' + kind }, [
            el('div', { class: 'tap-counter-label' }, [label]),
            display,
            el('div', { class: 'tap-counter-buttons' }, [
                el('button', { type: 'button', class: 'tap-counter-btn tap-counter-minus', onclick: () => tap(display, hidden, -1) }, ['−']),
                el('button', { type: 'button', class: 'tap-counter-btn tap-counter-plus', onclick: () => tap(display, hidden, +1) }, ['+'])
            ])
        ]);
        form.appendChild(el('div', { class: 'tap-counter-row' }, [
            buildCounter('YOUR TOUCHES', 'tap-counter-you', myInput, myDisplay),
            buildCounter('THEIR TOUCHES', 'tap-counter-them', themInput, themDisplay)
        ]));
        form.appendChild(myInput);
        form.appendChild(themInput);
    }

    // SECTION: How I scored — tally per tactic
    const whoName = (activeProfile()?.name) || 'You';
    const headA = sectionLabel(`How ${whoName} scored`);
    form.appendChild(headA);
    form.appendChild(el('p', {
        class: 'auth-tagline',
        style: { fontSize: '13px', margin: '0 0 12px', maxWidth: 'none' }
    }, ['For each action: how many touches it WON you, and how many times you tried it and MISSED. The scored numbers should add up to your score above.']));
    const scoringWidget = tacticTally({
        options: scoringOpts.map((t) => ({ slug: t.slug, label: t.label })),
        values: editing?.scoring_actions || [],
        // Read the live score off the hidden input the tap counters write to,
        // so the tally can say how many touches are still unaccounted for.
        getScore: () => {
            const f = form.querySelector('input[name="my_score"]');
            return f ? parseInt(f.value, 10) || 0 : 0;
        }
    });
    form.appendChild(scoringWidget);
    refreshTally = () => scoringWidget.refreshSummary?.();
    refreshTally();

    // SECTION: How they scored on me
    const headB = sectionLabel('How the opponent scored');
    form.appendChild(headB);
    form.appendChild(el('p', {
        class: 'auth-tagline',
        style: { fontSize: '13px', margin: '0 0 12px', maxWidth: 'none' }
    }, [`The touches ${whoName} gave away. These should add up to their score above.`]));
    // Seeded from conceded_actions; falls back to the old flat failure_patterns
    // list so bouts logged before counts existed still open with their actions
    // selected (at zero, which is honest - the count was never recorded).
    const concededSeed = (editing?.conceded_actions?.length)
        ? editing.conceded_actions
        : (editing?.failure_patterns || []).map((slug) => ({ tactic_slug: slug, touches: 0 }));
    const failureWidget = concededTally({
        options: failureOpts.map((t) => ({ slug: t.slug, label: t.label })),
        values: concededSeed,
        getScore: () => {
            const f = form.querySelector('input[name="their_score"]');
            return f ? parseInt(f.value, 10) || 0 : 0;
        }
    });
    form.appendChild(failureWidget);
    refreshConceded = () => failureWidget.refreshSummary?.();
    refreshConceded();

    // SECTION: Reflection
    form.appendChild(sectionLabel('Reflection'));
    form.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label' }, ['One line']),
        el('input', { type: 'text', name: 'reflection', class: 'field-input', value: editing?.reflection || '', placeholder: 'what I noticed' })
    ]));
    // SECTION: Drills you used in this bout (Phase 2 — auto-promotes drills to Match-ready on a win)
    {
        const profileForChips = (typeof profile !== 'undefined' && profile) ? profile : null;
        const weaknesses = profileForChips ? getWeaknessDrills(profileForChips.role) : [];
        const allDrills = [];
        for (const w of weaknesses) {
            for (const p of (w.technique || []).concat(w.body || [])) {
                allDrills.push({ slug: tagToSlug(p.tag), tag: p.tag, weakness: w.slug });
            }
        }
        if (allDrills.length) {
            form.appendChild(sectionLabel('Drills you used'));
            const initial = new Set((editing?.tactics_used || []));
            const tacticsHidden = el('input', { type: 'hidden', name: 'tactics_used', value: Array.from(initial).join(',') });
            const chipRow = el('div', { class: 'chips', style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;' });
            for (const d of allDrills) {
                const chip = el('button', {
                    type: 'button',
                    'data-slug': d.slug,
                    style: 'background:transparent;border:1px solid rgba(0,0,0,0.12);padding:4px 10px;border-radius:999px;cursor:pointer;font-family:var(--eg-mono,monospace);font-size:11px;letter-spacing:0.04em;color:#6B7280;',
                    onclick: () => {
                        const selected = new Set(tacticsHidden.value.split(',').filter(Boolean));
                        if (selected.has(d.slug)) selected.delete(d.slug);
                        else selected.add(d.slug);
                        tacticsHidden.value = Array.from(selected).join(',');
                        chipRow.querySelectorAll('button').forEach(b => {
                            const sl = b.getAttribute('data-slug');
                            const on = selected.has(sl);
                            b.style.background = on ? 'rgba(34,139,34,0.15)' : 'transparent';
                            b.style.color = on ? '#1f7a1f' : '#6B7280';
                            b.style.border = on ? '1px solid #1f7a1f' : '1px solid rgba(0,0,0,0.12)';
                        });
                    }
                }, [d.tag]);
                if (initial.has(d.slug)) {
                    chip.style.background = 'rgba(34,139,34,0.15)';
                    chip.style.color = '#1f7a1f';
                    chip.style.border = '1px solid #1f7a1f';
                }
                chipRow.appendChild(chip);
            }
            form.appendChild(el('div', { style: 'font-size:12px;color:#6B7280;margin-bottom:6px;' }, ['Tap any drill whose tactic you actually used — winning bouts auto-promote those drills to 🏆 Match-ready.']));
            form.appendChild(chipRow);
            form.appendChild(tacticsHidden);
        }
    }

    form.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label' }, ['Coach feedback']),
        el('textarea', { name: 'coach_feedback', class: 'field-textarea', rows: 3, placeholder: 'if any' }, [editing?.coach_feedback || ''])
    ]));

    // SUBMIT
    form.appendChild(el('div', { style: { display: 'flex', gap: '10px', marginTop: '24px', paddingTop: '20px', borderTop: '1px solid var(--rule)' } }, [
        el('a', { href: '#bouts', class: 'btn btn-ghost btn-mono-label', style: { flex: '1', textDecoration: 'none' } }, ['Cancel']),
        el('button', { type: 'submit', class: 'btn btn-primary btn-mono-label', style: { flex: '2' } }, [editingRow ? 'Save changes' : 'Save bout'])
    ]));

    async function save() {
        const fd = new FormData(form);
        const my = Number(fd.get('my_score'));
        const their = Number(fd.get('their_score'));
        const outcome = my === their ? 'draw' : (my > their ? 'win' : 'loss');

        const opName = (fd.get('opponent_name') || '').toString().trim();
        if (!opName) { toast('Opponent is required', 'error'); return; }

        const trackerId = parseInt((fd.get('opponent_tracker_id') || '').toString(), 10) || null;
        const sourceId = (fd.get('source_bout_id') || '').toString().trim() || null;
        let opponent = null;
        try {
            opponent = await findOrCreateOpponent({
                name: opName,
                club: (fd.get('opponent_club') || '').toString().trim() || null,
                rating: (fd.get('opponent_rating') || '').toString().trim() || null,
                tracker_id: trackerId
            });
        } catch (e) {
            console.warn('opponent lookup failed', e);
        }

        const payload = {
            profile_id: profile.id,
            date: fd.get('date'),
            location: (fd.get('location') || '').toString().trim() || null,
            context: selectedCtx || null,
            opponent_id: opponent?.id || null,
            opponent_tracker_id: trackerId,
            source_bout_id: sourceId,
            opponent_name: opName,
            opponent_rating: (fd.get('opponent_rating') || '').toString().trim() || null,
            opponent_club: (fd.get('opponent_club') || '').toString().trim() || null,
            my_score: isNaN(my) ? null : my,
            their_score: isNaN(their) ? null : their,
            outcome,
            scoring_actions: scoringWidget.getValues(),
            conceded_actions: failureWidget.getValues(),
            failure_patterns: failureWidget.getSlugs(),
            reflection: (fd.get('reflection') || '').toString().trim() || null,
            coach_feedback: (fd.get('coach_feedback') || '').toString().trim() || null,
            tactics_used: (fd.get('tactics_used') || '').toString().split(',').filter(Boolean)
        };

        try {
            let savedBoutId = editingRow?.id || null;
            if (editingRow) {
                await safeWrite({ table: 'bouts', op: 'update', payload, match: { id: editingRow.id } });
                toast('Bout updated');
            } else {
                const inserted = await safeWrite({ table: 'bouts', op: 'insert', payload });
                if (inserted && inserted.id) savedBoutId = inserted.id;
                toast('Bout logged' + (navigator.onLine ? '' : ' (offline — will sync)'));
            }
            // Auto-promote drills to 🏆 Match-ready when the bout was won AND tactics were tagged.
            try {
                if (outcome === 'win' && Array.isArray(payload.tactics_used) && payload.tactics_used.length) {
                    const weaknesses = getWeaknessDrills(profile.role);
                    const slugToWeakness = new Map();
                    for (const w of weaknesses) {
                        for (const p of (w.technique || []).concat(w.body || [])) {
                            slugToWeakness.set(tagToSlug(p.tag), w.slug);
                        }
                    }
                    // In parallel, and not awaited before leaving the page: these
                    // were sent one at a time and made "Saving..." last ten seconds
                    // on venue wifi. The bout itself is already saved by now.
                    const writes = payload.tactics_used
                        .map((drillSlug) => ({ drillSlug, wSlug: slugToWeakness.get(drillSlug) }))
                        .filter((x) => x.wSlug)
                        .map(({ drillSlug, wSlug }) => logDrillSession({
                            profileId: profile.id, drillSlug, weaknessSlug: wSlug,
                            reps: 1, rating: 5, note: 'used in real bout #coach', boutId: savedBoutId
                        }).catch(e => console.warn('drill promo fail', e)));
                    Promise.all(writes).catch(() => {});
                }
            } catch (e) { console.warn('promote-drill flow failed', e); }
            go('bouts');
        } catch (e) {
            toast('Save failed: ' + e.message, 'error');
        }
    }
}

function sectionLabel(text) {
    return el('div', { class: 'label-row', style: { margin: '24px 0 4px' } }, [
        el('span', { class: 'label' }, [text])
    ]);
}

// =====================================================
// DETAIL — editorial bout-card with full breakdown
// =====================================================
export async function mountBoutDetail(root, params) {
    if (!params.id) return go('bouts');
    let b;
    try { b = await getBout(params.id); }
    catch (e) {
        root.appendChild(el('div', { class: 'card', style: { color: 'var(--loss)', margin: '24px var(--gut)' } }, ['Bout not found.']));
        return;
    }
    // getBout fetches by id alone and both boys share one login, so a bout
    // URL opened under the wrong profile rendered the other boy's bout beneath
    // this one's name. Send it back to the list instead.
    const me = activeProfile();
    if (me && b.profile_id && b.profile_id !== me.id) {
        toast('That bout belongs to another profile');
        return go('bouts');
    }

    const taxos = await loadTaxonomies();
    const my = b.my_score ?? 0;
    const their = b.their_score ?? 0;
    const isWin = b.outcome === 'win';
    const isLoss = b.outcome === 'loss';

    root.appendChild(el('div', { style: { padding: '40px var(--gut) 8px' } }, [
        el('h1', { class: 'page-eyebrow' }, [b.opponent_name || 'Bout']),
        el('div', { class: 'today-sub' }, [
            el('span', {}, [fmtDateLong(b.date).toUpperCase()])
        ])
    ]));

    // Hero score
    const total = my + their;
    const ticks = [];
    for (let i = 0; i < total; i++) {
        ticks.push(el('span', { class: i < my ? 'touch-tick is-scored' : 'touch-tick' }));
    }
    const lastAct = (b.scoring_actions || []).slice(-1)[0];
    if (lastAct && /flick/i.test(lastAct.tactic_slug || '') && my > 0 && ticks[my - 1]) {
        ticks[my - 1] = el('span', { class: 'touch-tick is-flick' });
    }

    root.appendChild(el('div', { style: { padding: '12px var(--gut) 24px' } }, [
        el('div', { class: 'scoreline' }, [
            el('span', { class: `scoreline-num ${isWin ? 'is-win' : (isLoss ? 'is-loss' : '')}`, style: { fontSize: '48px' } }, [String(my)]),
            el('span', { class: 'scoreline-sep', style: { fontSize: '32px' } }, ['—']),
            el('span', { class: 'scoreline-num', style: { fontSize: '48px' } }, [String(their)]),
            el('span', { class: `scoreline-result ${isWin ? 'is-win' : (isLoss ? 'is-loss' : '')}`, style: { marginLeft: '14px' } }, [b.outcome || ''])
        ]),
        ticks.length ? el('div', { class: 'touch-strip', style: { marginTop: '12px' } }, ticks) : null,
        el('div', { class: 'bout-card-meta', style: { marginTop: '12px' } }, [
            CONTEXT_OPTIONS.find((c) => c.value === b.context)?.label
                ? el('span', {}, [(CONTEXT_OPTIONS.find((c) => c.value === b.context)?.label).toUpperCase()])
                : null,
            b.location ? el('span', {}, [b.location.toUpperCase()]) : null
        ])
    ]));

    // Scoring tally
    root.appendChild(el('div', { class: 'label-row' }, [el('span', { class: 'label' }, [`How ${me?.name || 'I'} scored`])]));
    if (b.scoring_actions?.length) {
        root.appendChild(el('div', { class: 'chip-row', style: { padding: '0 var(--gut)' } }, b.scoring_actions.map((a) => {
            // Words, as on the form: "3/4" did not say which number was which.
            const missed = Math.max(0, (a.attempts || 0) - (a.successes || 0));
            return el('span', { class: 'chip is-on', style: { color: 'var(--ink)' } }, [
                taxos.tacticBySlug.get(a.tactic_slug)?.label || a.tactic_slug,
                el('span', { class: 'num', style: { marginLeft: '8px', color: '#6B7280' } }, [
                    `${a.successes || 0} scored${missed ? ` · ${missed} missed` : ''}`
                ])
            ]);
        })));
    } else {
        root.appendChild(el('p', { class: 'empty-line', style: { padding: '0 var(--gut)', fontSize: '15px' } }, ['No tactics tallied.']));
    }

    // Failure patterns
    root.appendChild(el('div', { class: 'label-row', style: { marginTop: '24px' } }, [el('span', { class: 'label' }, ['How the opponent scored'])]));
    // conceded_actions carries the counts the form now records; failure_patterns
    // is the older flat list, kept as the fallback for bouts logged before counts.
    if (b.conceded_actions?.length) {
        root.appendChild(el('div', { class: 'chip-row', style: { padding: '0 var(--gut)' } }, b.conceded_actions.map((c) =>
            el('span', { class: 'chip is-on', style: { color: 'var(--ink)' } }, [
                taxos.tacticBySlug.get(c.tactic_slug)?.label || c.tactic_slug,
                el('span', { class: 'num', style: { marginLeft: '8px', color: '#6B7280' } }, [
                    `${Number(c.touches) || 0} touch${Number(c.touches) === 1 ? '' : 'es'}`
                ])
            ])
        )));
    } else if (b.failure_patterns?.length) {
        root.appendChild(el('div', { class: 'chip-row', style: { padding: '0 var(--gut)' } }, b.failure_patterns.map((s) =>
            el('span', { class: 'tag tag-weakness', style: { color: 'var(--ink)' } }, [taxos.tacticBySlug.get(s)?.label || s])
        )));
    } else {
        root.appendChild(el('p', { class: 'empty-line', style: { padding: '0 var(--gut)', fontSize: '15px' } }, ['Nothing logged.']));
    }

    // Reflection
    if (b.reflection) {
        root.appendChild(el('div', { class: 'label-row', style: { marginTop: '24px' } }, [el('span', { class: 'label' }, ['Reflection'])]));
        root.appendChild(el('p', { class: 'bout-card-quote', style: { padding: '0 var(--gut)' } }, [b.reflection]));
    }

    // Coach feedback
    if (b.coach_feedback) {
        root.appendChild(el('div', { class: 'label-row', style: { marginTop: '24px' } }, [el('span', { class: 'label' }, ['Coach said'])]));
        root.appendChild(el('p', {
            style: {
                padding: '0 var(--gut)',
                fontFamily: 'var(--serif)',
                fontStyle: 'italic',
                fontSize: '17px',
                lineHeight: '1.5',
                color: 'var(--ink-soft)',
                borderLeft: '2px solid var(--gold-soft)',
                marginLeft: 'var(--gut)',
                paddingLeft: '14px'
            }
        }, [b.coach_feedback]));
    }

    // Claude debrief — generated by AI, cached in coach_notes
    // What the opponent has actually done this year, from FencingTracker, when
    // the bout is linked to a record - and the questions the coach needs
    // answered when a bout was quick-logged with only a score.
    root.appendChild(await buildOpponentRecordCard(b));
    if (!(b.scoring_actions?.length) && !(b.conceded_actions?.length)) {
        root.appendChild(buildDebriefQuestions(b));
    }
    root.appendChild(buildBoutDebriefCard(b));

    // Actions
    root.appendChild(el('div', { class: 'foil-divider' }));
    root.appendChild(el('div', { style: { display: 'flex', gap: '10px', padding: '0 var(--gut) 32px' } }, [
        el('a', { href: `#bouts/edit?id=${b.id}`, class: 'btn btn-ghost btn-mono-label', style: { flex: '1', textDecoration: 'none' } }, ['Edit']),
        b.opponent_id ? el('a', { href: `#opponents/show?id=${b.opponent_id}`, class: 'btn btn-ghost btn-mono-label', style: { flex: '1', textDecoration: 'none' } }, ['Scout card']) : null,
        el('button', {
                type: 'button', class: 'btn btn-ghost btn-sm',
                // A reversed score is the common quick-log mistake. Swapping is a
                // one-tap fix that keeps the bout instead of delete-and-redo.
                onclick: async (e) => {
                    const sb = e.currentTarget; sb.disabled = true;
                    try {
                        const my = b.their_score ?? 0, their = b.my_score ?? 0;
                        await safeWrite({ table: 'bouts', op: 'update', match: { id: b.id }, payload: {
                            my_score: my, their_score: their,
                            outcome: my > their ? 'win' : their > my ? 'loss' : 'draw'
                        } });
                        toast(`Scores swapped: now ${my}\u2013${their}`);
                        location.reload();
                    } catch (err) {
                        sb.disabled = false;
                        toast('Could not swap: ' + (err.message || err), 'error');
                    }
                }
            }, ['Swap the scores']),
            el('button', {
            class: 'btn btn-ghost btn-mono-label',
            style: { color: 'var(--loss)', borderColor: 'rgba(192,138,126,0.3)' },
            onclick: async (e) => {
                const btn = e.currentTarget;
                if (btn.dataset.confirming !== '1') {
                    const orig = btn.textContent;
                    btn.dataset.origText = orig;
                    btn.dataset.confirming = '1';
                    btn.textContent = 'Confirm delete?';
                    setTimeout(() => {
                        if (btn.dataset.confirming === '1') {
                            btn.textContent = btn.dataset.origText || 'Delete';
                            btn.dataset.confirming = '';
                        }
                    }, 4000);
                    return;
                }
                btn.disabled = true;
                btn.textContent = 'Deleting…';
                try {
                    // Soft delete: gone from their view, but recoverable.
                    await safeWrite({
                        table: 'bouts',
                        op: 'update',
                        payload: { deleted_at: new Date().toISOString() },
                        match: { id: b.id }
                    });
                    toast('Deleted');
                    go('bouts');
                } catch (err) {
                    btn.disabled = false;
                    btn.dataset.confirming = '';
                    btn.textContent = btn.dataset.origText || 'Delete';
                    toast('Delete failed: ' + (err?.message || 'unknown'));
                }
            }
        }, ['Delete'])
    ]));
}

// =====================================================
// Claude bout debrief — appears under bout detail
// =====================================================
function buildBoutDebriefCard(bout) {
    const wrap = el('section', {
        class: 'coach-card',
        style: {
            margin: '24px var(--gut) 8px', padding: '22px 24px',
            background: 'var(--surface)', borderRadius: 'var(--r-card, 18px)',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.04)'
        }
    });
    const head = el('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }
    }, [
        el('div', { class: 'metric-label' }, ['Debrief']),
        el('div', { class: 'meta', style: { fontSize: '11px', color: 'var(--ink-mute)' } }, ['by Claude'])
    ]);
    wrap.appendChild(head);

    const body = el('div', { class: 'coach-card-body' });
    wrap.appendChild(body);

    renderEmpty();

    function renderEmpty() {
        body.innerHTML = '';
        body.appendChild(el('p', {
            style: { margin: '6px 0 14px', color: 'var(--ink-mute)', fontStyle: 'italic' }
        }, ['Get a debrief — what happened, the root cause, and the next training touch.']));
        body.appendChild(el('button', {
            type: 'button', class: 'btn btn-primary',
            onclick: handleGenerate
        }, ['Debrief this bout']));
    }
    function renderLoading() {
        body.innerHTML = '';
        body.appendChild(el('p', {
            style: { margin: '6px 0', color: 'var(--ink-mute)' }
        }, ['Asking Claude. One moment…']));
    }
    function renderResponse(text, model) {
        body.innerHTML = '';
        body.appendChild(el('div', {
            style: { whiteSpace: 'pre-wrap', lineHeight: '1.55', fontSize: '15px', color: 'var(--ink)' }
        }, [text]));
        body.appendChild(el('div', {
            class: 'kicker',
            style: { marginTop: '12px', fontSize: '11px', color: 'var(--ink-mute)' }
        }, [`${model || 'claude'} · click Regenerate for a fresh take`]));
        body.appendChild(el('div', { style: { marginTop: '12px' } }, [
            el('button', {
                type: 'button', class: 'btn btn-ghost btn-sm',
                style: { fontSize: '12px' }, onclick: handleGenerate
            }, ['Regenerate'])
        ]));
    }
    function renderError(msg) {
        body.innerHTML = '';
        body.appendChild(el('p', { style: { color: 'var(--loss)' } }, ['Could not get debrief: ' + msg]));
        body.appendChild(el('button', {
            type: 'button', class: 'btn btn-ghost btn-sm',
            onclick: handleGenerate
        }, ['Try again']));
    }
    async function handleGenerate() {
        renderLoading();
        try {
            const res = await boutDebrief(bout.id);
            if (res?.text) renderResponse(res.text, res.model);
            else renderError('empty response');
        } catch (e) {
            renderError(e.message || String(e));
        }
    }

    // On mount — show cached debrief if one exists
    (async () => {
        try {
            const notes = await listCoachNotes({ kind: 'bout-debrief', boutId: bout.id, limit: 1 });
            if (notes[0]) renderResponse(notes[0].response_text, notes[0].model);
        } catch (_) { /* ignore */ }
    })();

    return wrap;
}

// ---------------------------------------------------------------------------
// Opponent record: the black-and-white read of who he just fenced.
// ---------------------------------------------------------------------------
const MUTE = '#6B7280';
async function buildOpponentRecordCard(b) {
    const wrap = el('section', { class: 'card', style: { margin: '18px var(--gut) 0' } });
    let tid = b.opponent_tracker_id;

    // A typed name is often close but not exact ("Gutimeltla"). Link it when
    // exactly one loaded record shares the surname, case-insensitively.
    if (!tid && b.opponent_name) {
        const surname = String(b.opponent_name).split(',')[0].trim().toLowerCase().slice(0, 5);
        if (surname.length >= 4) {
            const { data } = await supa.from('opponent_profiles').select('tracker_id,name').ilike('name', surname + '%').limit(3);
            if (data?.length === 1) {
                tid = data[0].tracker_id;
                supa.from('bouts').update({ opponent_tracker_id: tid, opponent_name: data[0].name }).eq('id', b.id).then(() => {});
            }
        }
    }
    if (!tid) {
        wrap.appendChild(el('div', { class: 'label', style: { color: MUTE } }, ['Opponent record']));
        wrap.appendChild(el('p', { style: { color: MUTE, fontSize: '13px', margin: '6px 0 0' } }, [
            'No FencingTracker record linked for this opponent yet. Records load for the fencers seeded around you at each event.'
        ]));
        return wrap;
    }

    const [{ data: op }, { data: fl }, { data: wins }] = await Promise.all([
        supa.from('opponent_profiles').select('*').eq('tracker_id', tid).maybeSingle(),
        supa.from('opponent_flags').select('*').eq('tracker_id', tid).maybeSingle(),
        supa.from('opponent_windows').select('*').eq('tracker_id', tid)
    ]);
    if (!op) return wrap;
    const w = Object.fromEntries((wins || []).map((x) => [x.window_days, x]));
    const m = (d) => w[d]?.median_pct;

    wrap.appendChild(el('div', { class: 'label', style: { color: MUTE } }, ['Opponent record · FencingTracker']));
    wrap.appendChild(el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', margin: '6px 0 2px' } }, [
        el('a', { href: op.tracker_url, target: '_blank', rel: 'noopener', style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '22px', color: 'var(--ink)', textDecoration: 'none' } }, [op.name]),
        el('span', { class: 'label', style: { color: MUTE } }, [[op.club, op.birth_year ? `born ${op.birth_year}` : null, op.rating].filter(Boolean).join(' · ')])
    ]));
    wrap.appendChild(el('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap', margin: '8px 0 10px' } }, [
        stat('DE strength', op.strength_de), stat('Pool strength', op.strength_pool),
        stat('3-mo median finish', m(90) == null ? '—' : `${m(90)}%`),
        stat('12-mo median finish', m(365) == null ? '—' : `${m(365)}%`),
        stat('Events, 90 days', w[90]?.events ?? '—')
    ]));
    const flags = fl?.flags || [];
    if (flags.length) {
        wrap.appendChild(el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, flags.map((f) => {
            const [head, detail] = String(f).split(':');
            const bad = /rusty|fades|dropping|thin|soft|erratic|no results/i.test(head);
            return el('span', { class: 'label', title: detail || '', style: { border: '1px solid ' + (bad ? '#B45309' : 'var(--rule-strong)'), color: bad ? '#B45309' : MUTE, borderRadius: 'var(--r-pill)', padding: '3px 8px', fontWeight: bad ? '700' : '500' } }, [head + (detail ? ` · ${detail}` : '')]);
        })));
    }
    wrap.appendChild(el('p', { style: { color: MUTE, fontSize: '12px', margin: '10px 0 0', lineHeight: '1.5' } }, [
        'Median finish is place as a share of the field: 30% means he usually finishes in the top third. Lower is stronger. Flags are read from placings alone.'
    ]));
    return wrap;
}

function stat(label, value) {
    return el('div', {}, [
        el('div', { class: 'label', style: { color: MUTE } }, [label]),
        el('div', { class: 'num', style: { fontSize: '18px', fontWeight: '600', color: 'var(--ink)' } }, [String(value ?? '—')])
    ]);
}

// ---------------------------------------------------------------------------
// Three questions a coach asks about a bout that was only scored. The answers
// go on the bout, and the debrief reads them.
// ---------------------------------------------------------------------------
function buildDebriefQuestions(b) {
    const wrap = el('section', { class: 'card', style: { margin: '18px var(--gut) 0' } });
    wrap.appendChild(el('div', { class: 'label', style: { color: MUTE } }, ['Tell the coach what happened']));
    wrap.appendChild(el('p', { style: { color: MUTE, fontSize: '13px', margin: '6px 0 12px', lineHeight: '1.5' } }, [
        'Three short answers. Honest beats polished. The debrief below uses them.'
    ]));
    const q = (label, placeholder) => {
        const ta = el('textarea', { class: 'field-textarea', rows: 2, placeholder });
        wrap.appendChild(el('div', { class: 'field', style: { marginBottom: '10px' } }, [
            el('label', { class: 'field-label' }, [label]), ta
        ]));
        return ta;
    };
    const q1 = q('How did they score most of their touches?', 'e.g. parry-riposte every time I attacked; counter-attack into my prep; kept the distance long and hit me as I closed');
    const q2 = q('What did you try in the first three touches?', 'e.g. direct attack twice, then a beat attack');
    const q3 = q('When it was 0–5, what did you change?', 'e.g. nothing - kept attacking; started waiting; tried second intention');
    const btn = el('button', { class: 'btn btn-mono-label', style: { width: '100%', marginTop: '4px' } }, ['Save answers and debrief']);
    btn.onclick = async () => {
        const parts = [
            q1.value.trim() && `How they scored: ${q1.value.trim()}`,
            q2.value.trim() && `First three touches: ${q2.value.trim()}`,
            q3.value.trim() && `At 0-5 I changed: ${q3.value.trim()}`
        ].filter(Boolean);
        if (!parts.length) { toast('Answer at least one', 'error'); return; }
        btn.disabled = true; btn.textContent = 'Saving…';
        const reflection = [b.reflection, ...parts].filter(Boolean).join('\n');
        try {
            await safeWrite({ table: 'bouts', op: 'update', match: { id: b.id }, payload: { reflection } });
            b.reflection = reflection;
            toast('Saved - asking the coach');
            const debriefBtn = document.querySelector('.coach-card button');
            if (debriefBtn) debriefBtn.click();
            wrap.remove();
        } catch (e) {
            btn.disabled = false; btn.textContent = 'Save answers and debrief';
            toast('Could not save: ' + (e.message || e), 'error');
        }
    };
    wrap.appendChild(btn);
    return wrap;
}
