// Module 3.6 — Opponents, SWOT, 5W2H scout cards.

import { el, fmtDate, fmtDateLong, toast } from '../lib/util.js';
import { go } from '../lib/router.js';
import { supa } from '../lib/supa.js';
import { activeProfile } from '../lib/state.js';
import {
    listOpponents, getOpponent,
    getSwot, upsertSwot, listScoutCards,
    listBouts, loadTaxonomies, findOrCreateOpponent
} from '../lib/db.js';
import { chipArrayEditor, chipGroup, scaleSlider } from '../lib/chips.js';
import { getIntel, getNationalRoster, getRosterRankKey } from '../lib/fencer-intel.js';
import { safeWrite } from '../lib/offline.js';
import {
    priorityFor, flatPriorityOpponents,
    STYLE_QUESTIONS, SHARED_PATTERNS, PRIORITY_META
} from '../lib/priority-targets.js';

// The drill data carries emoji in its labels. Strip them at render time so the
// screen matches the rest of the site; the data is left as it is.
const noEmoji = (t) => String(t ?? '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/^\s+/, '');
import { opponentProfiler, listCoachNotes } from '../lib/coach.js';
import { renderMeetingsCard, recordsByTracker, autoFillOpponent, linkOpponentsByName } from '../lib/lost-bouts.js';

// Win-loss record against each opponent from the competition results, keyed
// by tracker id; filled by the list screen before the cards render.
let RECORDS = new Map();

const ARCHETYPES = [
    { slug: 'aggressive',   label: 'Aggressive' },
    { slug: 'technical',    label: 'Technical' },
    { slug: 'unpredictable',label: 'Unpredictable' },
    { slug: 'defensive',    label: 'Defensive' },
    { slug: 'counter',      label: 'Counter-fencer' },
    { slug: 'long-arm',     label: 'Long-arm / runner' },
    { slug: 'lefty',        label: 'Left-handed' }
];

// =====================================================
// LIST — editorial recipe-card grid
// =====================================================
export async function mountOpponentsList(root) {
    const profile = activeProfile();
    if (!profile) {
        root.appendChild(el('div', { class: 'empty' }, [
            el('p', { class: 'empty-line' }, ['Pick a profile.'])
        ]));
        return;
    }

    root.appendChild(el('div', { style: { padding: '40px var(--gut) 8px' } }, [
        el('h1', { class: 'page-eyebrow' }, ['Scout']),
        el('div', { class: 'today-sub' }, [
            el('span', {}, [profile.name.toUpperCase()])
        ])
    ]));

    let opps = [];
    try { opps = await listOpponents(); }
    catch (e) {
        return root.appendChild(el('div', { class: 'card', style: { color: 'var(--loss)', margin: '0 var(--gut)' } }, [`Failed to load: ${e.message}`]));
    }
    // A record typed by name is matched to the results by surname, so the
    // head-to-head follows it without anyone pasting a tracker link.
    try { await linkOpponentsByName(profile, opps); } catch (e) { console.warn('name links skipped', e); }
    try { RECORDS = await recordsByTracker(profile, opps.map((o) => o.tracker_id)); }
    catch (e) { console.warn('records skipped', e); RECORDS = new Map(); }

    // Priority targets — Summer Nationals 2026 prep
    const intel = priorityFor(profile.role);
    if (intel) {
        root.appendChild(buildPrioritySection(profile, intel, opps));
    }

    // National roster — Y14 top 100 for Raedyn, Y12 top 174 for Kaylan
    const rankKey = getRosterRankKey(profile);
    if (rankKey) {
        const rosterSection = el('section', { class: 'nat-roster', style: { margin: '8px 0 16px' } });
        rosterSection.appendChild(el('div', { class: 'nat-roster-head', style: { padding: '0 var(--gut)', marginBottom: '8px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' } }, [
            el('span', { class: 'label', style: { color: 'var(--eg-mind, #8B5CF6)' } }, [`${rankKey.toUpperCase()} NATIONAL ROSTER`]),
            el('span', { class: 'nat-roster-count', style: { fontFamily: 'var(--eg-mono, monospace)', fontSize: '11px', color: 'var(--ink-mute)' } }, ['…'])
        ]));
        // Search bar
        const rosterSearch = el('input', {
            type: 'text', class: 'field-input',
            placeholder: `Search ${rankKey.toUpperCase()} top-list by name or club…`,
            oninput: (e) => renderRoster(e.target.value)
        });
        rosterSection.appendChild(el('div', { style: { padding: '0 var(--gut) 8px' } }, [
            el('div', { class: 'field' }, [el('label', { class: 'field-label' }, ['Find ranked fencer']), rosterSearch])
        ]));
        const rosterList = el('div', { class: 'nat-roster-list', style: { padding: '0 var(--gut)' } });
        rosterSection.appendChild(rosterList);
        root.appendChild(rosterSection);

        let _roster = [];
        getNationalRoster(profile).then(r => {
            _roster = r;
            rosterSection.querySelector('.nat-roster-count').textContent = `${r.length} FENCERS`;
            renderRoster('');
        });

        function renderRoster(filter) {
            const f = (filter || '').toLowerCase().trim();
            const filtered = !f ? _roster : _roster.filter(x =>
                (x.name || '').toLowerCase().includes(f) ||
                (x.club || '').toLowerCase().includes(f)
            );
            rosterList.innerHTML = '';
            if (!filtered.length) {
                rosterList.appendChild(el('p', { class: 'empty-line', style: { padding: '14px 0', fontSize: '14px' } }, ['No matches.']));
                return;
            }
            const cap = filtered.slice(0, 200);
            for (const r of cap) {
                rosterList.appendChild(buildRosterRow(r, rankKey, opps));
            }
            if (filtered.length > 200) {
                rosterList.appendChild(el('p', { style: { padding: '8px 0', fontSize: '11px', color: 'var(--ink-mute)', fontFamily: 'var(--eg-mono, monospace)' } }, [`+ ${filtered.length - 200} more — refine search`]));
            }
        }
    }

    if (!opps.length) {
        root.appendChild(el('div', { class: 'empty' }, [
            el('p', { class: 'empty-line' }, ["The opposition writes itself in. Log a bout and they'll appear here."]),
            el('a', { href: '#bouts/new', class: 'btn btn-primary btn-mono-label empty-cta' }, ['Log a bout'])
        ]));
        return;
    }

    // Filter input — uses .field for editorial styling
    const filterInput = el('input', {
        type: 'text', class: 'field-input', placeholder: 'filter by name or club…',
        oninput: (e) => render(e.target.value)
    });
    root.appendChild(el('div', { style: { padding: '0 var(--gut) 8px' } }, [
        el('div', { class: 'field' }, [
            el('label', { class: 'field-label' }, ['Find']),
            filterInput
        ])
    ]));

    const list = el('div', {});
    root.appendChild(list);

    function render(filter = '') {
        list.innerHTML = '';
        const f = filter.toLowerCase();
        const filtered = opps.filter((o) =>
            !f || (o.name || '').toLowerCase().includes(f) || (o.club || '').toLowerCase().includes(f)
        );
        for (const o of filtered) {
            list.appendChild(oppCard(o));
        }
        if (!filtered.length) {
            list.appendChild(el('p', { class: 'empty-line', style: { padding: '14px var(--gut)', fontSize: '15px' } }, ['No matches.']));
        }
    }
    render();
}

function buildRosterRow(r, rankKey, existingOpps) {
    const rank = r.ranks?.[rankKey];
    const headline = r.headline || '';
    // If we've already logged this fencer, link straight there; otherwise create-on-tap
    const existing = (existingOpps || []).find(o => (o.name || '').toLowerCase() === (r.name || '').toLowerCase());
    const row = el('button', {
        type: 'button',
        class: 'nat-row',
        onclick: async () => {
            try {
                if (existing) {
                    location.hash = `#opponents/show?id=${existing.id}`;
                    return;
                }
                row.disabled = true;
                row.querySelector('.nat-row-arrow').textContent = '…';
                const created = await findOrCreateOpponent({
                    name: r.name,
                    club: r.club || null,
                    rating: null
                });
                location.hash = `#opponents/show?id=${created.id}`;
            } catch (e) {
                row.disabled = false;
                row.querySelector('.nat-row-arrow').textContent = '↗';
                toast('Could not open: ' + e.message, 'error');
            }
        }
    }, [
        el('span', { class: 'nat-row-rank' }, [`#${rank}`]),
        el('div', { class: 'nat-row-body' }, [
            el('div', { class: 'nat-row-name' }, [r.name]),
            el('div', { class: 'nat-row-club' }, [r.club || '—']),
            headline ? el('div', { class: 'nat-row-headline' }, [noEmoji(headline)]) : null
        ].filter(Boolean)),
        existing
            ? el('span', { class: 'nat-row-tag', title: 'Already scouted' }, [''])
            : null,
        el('span', { class: 'nat-row-arrow' }, ['↗'])
    ].filter(Boolean));
    return row;
}

function oppCard(o) {
    const archs = (o.archetypes || []).slice(0, 3);
    const rec = o.tracker_id ? RECORDS.get(o.tracker_id) : null;
    return el('a', {
        href: `#opponents/show?id=${o.id}`,
        class: 'opp-card',
        style: { textDecoration: 'none', color: 'inherit', display: 'block' }
    }, [
        el('div', { class: 'opp-card-head' }, [
            el('div', {}, [
                el('div', { class: 'opp-name' }, [o.name]),
                o.club ? el('div', { class: 'opp-club' }, [o.club]) : null,
                rec ? el('div', { class: 'opp-club', style: { color: rec.w > rec.l ? '#1f7a1f' : rec.l > rec.w ? '#9b2230' : '#6B7280' } }, [`Met ${rec.w + rec.l} time${rec.w + rec.l > 1 ? 's' : ''}: ${rec.w} won, ${rec.l} lost`]) : null
            ]),
            el('div', { class: 'opp-record' }, [
                o.rating || '—',
                el('span', { class: 'opp-record-label' }, ['RATING'])
            ])
        ]),
        archs.length || (o.hand && o.hand !== 'unknown')
            ? el('div', { class: 'opp-tag-row' }, [
                ...archs.map((a) => el('span', { class: 'tag' }, [a])),
                (o.hand && o.hand !== 'unknown') ? el('span', { class: 'tag' }, [o.hand[0].toUpperCase() + 'H']) : null
            ])
            : null
    ]);
}

// =====================================================
// DETAIL — opponent record + SWOT + scout cards + bout history
// =====================================================
export async function mountOpponentDetail(root, params) {
    if (!params.id) return go('opponents');
    const profile = activeProfile();

    let opp; try { opp = await getOpponent(params.id); }
    catch (e) { return root.appendChild(el('div', { class: 'card' }, ['Opponent not found.'])); }
    // Fill what the results know (tracker id, club, rating); never overwrite.
    try { const filled = await autoFillOpponent(profile, opp); if (filled) Object.assign(opp, filled); }
    catch (e) { console.warn('auto-fill skipped', e); }

    const [swot, cards, bouts, taxos] = await Promise.all([
        getSwot(params.id),
        listScoutCards(params.id),
        listBouts({ opponentId: params.id, limit: 20 }),
        loadTaxonomies()
    ]);

    root.appendChild(el('div', { class: 'section-head' }, [
        el('h2', {}, [opp.name]),
        el('span', { class: 'meta' }, [opp.club || '—'])
    ]));

    // Priority-target toggle pill
    const priorityToggleRow = el('div', { class: 'priority-toggle-row', style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '4px 0 14px' } });
    function renderPriorityToggle() {
        priorityToggleRow.innerHTML = '';
        const isPri = !!opp.is_priority_target;
        priorityToggleRow.appendChild(el('button', {
            type: 'button',
            class: isPri ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm',
            style: { fontSize: '12px', padding: '4px 12px' },
            onclick: async () => {
                const next = !opp.is_priority_target;
                try {
                    await safeWrite({ table: 'opponents', op: 'update', payload: { is_priority_target: next }, match: { id: opp.id } });
                    opp.is_priority_target = next;
                    renderPriorityToggle();
                    toast(next ? 'Marked as priority target' : 'Removed priority flag');
                } catch (e) { toast('Save failed: ' + e.message, 'error'); }
            }
        }, [isPri ? 'Priority target' : 'Mark as priority target']));
        if (opp.tracker_url) {
            priorityToggleRow.appendChild(el('a', {
                href: opp.tracker_url, target: '_blank', rel: 'noopener',
                class: 'btn btn-ghost btn-sm', style: { fontSize: '12px', padding: '4px 12px' }
            }, ['↗ Tracker']));
        }
    }
    renderPriorityToggle();
    root.appendChild(priorityToggleRow);

    // Every meeting from the competition results, wins and losses.
    try {
        const meetings = await renderMeetingsCard(profile, opp);
        if (meetings) root.appendChild(meetings);
    } catch (e) { console.warn('meetings skipped', e); }

    // editable header card
    const headerCard = el('div', { class: 'card bordered-accent' });
    root.appendChild(headerCard);
    renderHeaderCard();

    function renderHeaderCard() {
        headerCard.innerHTML = '';
        headerCard.appendChild(el('div', { class: 'row tight' }, [
            el('div', { class: 'field' }, [
                el('label', {}, ['Rating']),
                el('input', { type: 'text', value: opp.rating || '', oninput: (e) => updateField('rating', e.target.value) })
            ]),
            el('div', { class: 'field' }, [
                el('label', {}, ['Age category']),
                el('input', { type: 'text', value: opp.age_category || '', placeholder: 'Y14 / Cadet …', oninput: (e) => updateField('age_category', e.target.value) })
            ]),
            el('div', { class: 'field' }, [
                el('label', {}, ['Hand']),
                (() => {
                    const sel = el('select', { onchange: (e) => updateField('hand', e.target.value) },
                        ['unknown', 'right', 'left'].map((h) => el('option', { value: h, selected: opp.hand === h }, [h])));
                    return sel;
                })()
            ])
        ]));
        headerCard.appendChild(el('div', { class: 'field' }, [
            el('label', {}, ['Club']),
            el('input', { type: 'text', value: opp.club || '', oninput: (e) => updateField('club', e.target.value) })
        ]));
        headerCard.appendChild(el('div', { class: 'field' }, [
            el('label', {}, ['Archetype']),
            chipGroup({
                options: ARCHETYPES,
                selected: new Set(opp.archetypes || []),
                onChange: (vals) => updateField('archetypes', vals)
            })
        ]));
    }

    let saveTimer;
    function updateField(field, value) {
        opp = { ...opp, [field]: value };
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            try {
                await safeWrite({ table: 'opponents', op: 'update', payload: { [field]: value }, match: { id: opp.id } });
                toast('Saved');
            } catch (e) { toast('Save failed: ' + e.message, 'error'); }
        }, 500);
    }

    // FT Intel — tactical scout report (if fencer is in our intel DB)
    try {
        const ftPanel = await buildFtIntelPanel(opp);
        if (ftPanel) root.appendChild(ftPanel);
    } catch (e) { console.warn('FT intel skip', e); }

    // Claude profiler — Sonnet read on this opponent
    root.appendChild(buildOpponentProfilerCard(opp));

    // Style profile — 10-question interview
    root.appendChild(styleProfileEditor(opp, (vals) => { opp.style_profile = vals; }));

    // SWOT — auto-suggested from bouts
    const suggestedThreats = new Set();
    const suggestedOpps = new Set();
    for (const b of bouts) {
        for (const f of (b.failure_patterns || [])) suggestedThreats.add(taxos.tacticBySlug.get(f)?.label || f);
        for (const a of (b.scoring_actions || [])) {
            if (a.successes > 0) suggestedOpps.add(taxos.tacticBySlug.get(a.tactic_slug)?.label || a.tactic_slug);
        }
    }

    const cur = swot || { strengths: [], weaknesses: [], opportunities: [], threats: [] };
    // Tight placeholders — long ones get truncated on iPhone width. Type, press Enter.
    const sEditor = chipArrayEditor({ values: cur.strengths || [], onChange: () => debouncedSwot(), placeholder: 'e.g. fast lunge' });
    const wEditor = chipArrayEditor({ values: cur.weaknesses || [], onChange: () => debouncedSwot(), placeholder: 'e.g. slow recover' });
    const oEditor = chipArrayEditor({ values: cur.opportunities || [], onChange: () => debouncedSwot(), placeholder: 'e.g. attack-in-prep' });
    const tEditor = chipArrayEditor({ values: cur.threats || [], onChange: () => debouncedSwot(), placeholder: 'e.g. flick to back' });

    const swotSection = el('div', { class: 'section' }, [
        el('div', { class: 'section-head' }, [
            el('h2', {}, ['SWOT']),
            el('span', { class: 'meta' }, [swot ? `updated ${fmtDate(swot.updated_at?.slice(0, 10))}` : 'not started'])
        ]),
        el('div', { class: 'swot' }, [
            el('div', { class: 'quadrant s' }, [
                el('h4', {}, ['Strengths']),
                el('p', { class: 'quadrant-hint' }, ["what HE's good at"]),
                sEditor
            ]),
            el('div', { class: 'quadrant w' }, [
                el('h4', {}, ['Weaknesses']),
                el('p', { class: 'quadrant-hint' }, ['what HE struggles with']),
                wEditor
            ]),
            el('div', { class: 'quadrant o' }, [
                el('h4', {}, ['Opportunities (mine)']),
                el('p', { class: 'quadrant-hint' }, ['what I CAN do']),
                oEditor
            ]),
            el('div', { class: 'quadrant t' }, [
                el('h4', {}, ['Threats (theirs)']),
                el('p', { class: 'quadrant-hint' }, ['what HE does that scores on me']),
                tEditor
            ])
        ])
    ]);
    root.appendChild(swotSection);

    if (suggestedOpps.size || suggestedThreats.size) {
        const suggestionCard = el('div', { class: 'card', style: { borderLeft: '3px solid var(--accent)' } }, [
            el('h4', {}, ['Suggestions from bout data']),
            suggestedOpps.size
                ? el('div', { style: { marginBottom: '10px' } }, [
                    el('div', { class: 'kicker' }, ['scored against them with']),
                    el('div', { class: 'chips' }, Array.from(suggestedOpps).map((s) =>
                        el('button', {
                            class: 'chip', type: 'button',
                            onclick: () => { oEditor.setValues([...new Set([...(oEditor.getValues()), s])]); debouncedSwot(); }
                        }, ['+ ', s])
                    ))
                ])
                : null,
            suggestedThreats.size
                ? el('div', {}, [
                    el('div', { class: 'kicker' }, ['they scored on me with']),
                    el('div', { class: 'chips' }, Array.from(suggestedThreats).map((s) =>
                        el('button', {
                            class: 'chip failure', type: 'button',
                            onclick: () => { tEditor.setValues([...new Set([...(tEditor.getValues()), s])]); debouncedSwot(); }
                        }, ['+ ', s])
                    ))
                ])
                : null
        ]);
        root.appendChild(suggestionCard);
    }

    let swotTimer;
    function debouncedSwot() {
        clearTimeout(swotTimer);
        swotTimer = setTimeout(async () => {
            try {
                await upsertSwot(opp.id, {
                    strengths: sEditor.getValues(),
                    weaknesses: wEditor.getValues(),
                    opportunities: oEditor.getValues(),
                    threats: tEditor.getValues()
                });
            } catch (e) { toast('SWOT save failed: ' + e.message, 'error'); }
        }, 700);
    }

    // 5W2H scout cards
    root.appendChild(el('div', { class: 'section-head' }, [
        el('h2', {}, ['Scout cards']),
        el('span', { class: 'meta' }, [`${cards.length} card${cards.length === 1 ? '' : 's'}`])
    ]));
    root.appendChild(el('div', { class: 'btn-row', style: { marginBottom: '12px' } }, [
        el('a', { href: `#opponents/scout?id=${opp.id}`, class: 'btn' }, ['+ Pre-bout scout card'])
    ]));
    if (!cards.length) {
        root.appendChild(el('div', { class: 'empty' }, ['no scout cards yet']));
    } else {
        for (const c of cards) {
            root.appendChild(el('div', { class: 'scout-card', style: { marginBottom: '12px' } }, [
                el('div', { class: 'kicker', style: { marginBottom: '8px' } }, [fmtDateLong(c.bout_date || c.created_at?.slice(0, 10))]),
                el('div', { class: 'grid-7' }, [
                    field('Who', c.who),
                    field('What', c.what),
                    field('When', c.when_in_bout),
                    field('Where', c.where_scoring),
                    field('Why', c.why_they_win),
                    field('How', c.how_to_score),
                    field('Respect', c.respect_1_10 ? `${c.respect_1_10} / 10` : null)
                ])
            ]));
        }
    }

    // Bout history
    root.appendChild(el('div', { class: 'section-head', style: { marginTop: '24px' } }, [
        el('h2', {}, ['Past bouts']),
        el('span', { class: 'meta' }, [`${bouts.length} on record`])
    ]));
    if (!bouts.length) {
        root.appendChild(el('div', { class: 'empty' }, ['no bouts yet']));
    } else {
        for (const b of bouts) {
            root.appendChild(el('a', {
                href: `#bouts/show?id=${b.id}`, class: `bout-row ${b.outcome || ''}`, style: { textDecoration: 'none' }
            }, [
                el('div', { class: 'bout-date' }, [fmtDate(b.date)]),
                el('div', {}, [
                    el('div', { class: 'bout-opponent' }, [`${b.outcome === 'win' ? 'Won' : (b.outcome === 'loss' ? 'Lost' : 'Drew')} ${b.my_score ?? '?'}–${b.their_score ?? '?'}`]),
                    el('div', { class: 'bout-context' }, [b.location || ''])
                ]),
                el('div', { class: 'bout-score' }, [el('span', { class: 'you' }, [String(b.my_score ?? '–')]), ' – ', String(b.their_score ?? '–')])
            ]));
        }
    }

    function field(key, val) {
        return el('div', { class: 'field-static' }, [
            el('div', { class: 'key' }, [key]),
            el('div', { class: 'val' }, [val || '—'])
        ]);
    }
}

// =====================================================
// 5W2H scout-card form
// =====================================================
export async function mountScoutForm(root, params) {
    if (!params.id) return go('opponents');
    const opp = await getOpponent(params.id);
    const profile = activeProfile();

    root.appendChild(el('div', { class: 'section-head' }, [
        el('h2', {}, [`Scout: ${opp.name}`]),
        el('span', { class: 'meta' }, [profile.name])
    ]));

    const form = el('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); await save(); } });
    root.appendChild(form);

    function fld(label, name, ph) {
        return el('div', { class: 'field' }, [
            el('label', {}, [label]),
            el('input', { type: 'text', name, placeholder: ph || '' })
        ]);
    }

    form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, ['Date of upcoming bout (or today)']),
        el('input', { type: 'date', name: 'bout_date', value: new Date().toISOString().slice(0, 10) })
    ]));

    form.appendChild(fld('Who · name + club + archetype', 'who', `${opp.name}${opp.club ? ' · ' + opp.club : ''}`));
    form.appendChild(fld('What · their go-to action', 'what', 'e.g., attack-in-prep'));
    form.appendChild(fld('When · when in the bout do they peak?', 'when_in_bout', 'early / mid / late'));
    form.appendChild(fld('Where · where do they like to score?', 'where_scoring', 'high line / low line / flank'));
    form.appendChild(fld('Why · why do they win against me when they do?', 'why_they_win'));
    form.appendChild(fld('How · how am I going to score on them?', 'how_to_score'));

    const respect = scaleSlider({ value: 6 });
    form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, ['How much · respect 1–10']),
        respect
    ]));

    form.appendChild(el('div', { class: 'btn-row right' }, [
        el('a', { href: `#opponents/show?id=${opp.id}`, class: 'btn btn-ghost' }, ['Cancel']),
        el('button', { type: 'submit', class: 'btn' }, ['Save scout card'])
    ]));

    async function save() {
        const fd = new FormData(form);
        const payload = {
            opponent_id: opp.id,
            profile_id: profile.id,
            bout_date: fd.get('bout_date') || null,
            who: fd.get('who') || null,
            what: fd.get('what') || null,
            when_in_bout: fd.get('when_in_bout') || null,
            where_scoring: fd.get('where_scoring') || null,
            why_they_win: fd.get('why_they_win') || null,
            how_to_score: fd.get('how_to_score') || null,
            respect_1_10: respect.getValue()
        };
        try {
            await safeWrite({ table: 'opponent_5w2h', op: 'insert', payload });
            toast('Scout card saved');
            go('opponents/show', { id: opp.id });
        } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    }
}

// =====================================================
// PRIORITY TARGETS — Summer Nationals 2026 prep
// =====================================================
function normName(s) {
    return (s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[(),]/g, '');
}

function findOppByName(opps, name) {
    const target = normName(name);
    if (!target) return null;
    // exact, then prefix, then substring
    let m = opps.find((o) => normName(o.name) === target);
    if (m) return m;
    const surname = target.split(' ')[0];
    m = opps.find((o) => normName(o.name).startsWith(surname));
    return m || null;
}

function buildPrioritySection(profile, intel, opps) {
    const wrap = el('section', { class: 'priority-targets', style: { padding: '0 var(--gut) 8px' } });

    wrap.appendChild(el('div', { class: 'section-head', style: { marginBottom: '8px' } }, [
        el('h2', {}, ['Priority targets']),
        el('span', { class: 'meta' }, ['Summer Nationals · July 1 2026'])
    ]));

    wrap.appendChild(el('div', { class: 'kicker', style: { marginBottom: '14px' } }, [
        `pulled ${PRIORITY_META.pulled_at} from the results · `,
        profile.role === 'raedyn' ? `${PRIORITY_META.raedyn_total_bouts} career bouts`
            : profile.role === 'kaylan' ? `${PRIORITY_META.kaylan_total_bouts} career bouts`
            : 'family view'
    ]));

    // Never beaten — high priority
    if (intel.never_beaten?.length) {
        wrap.appendChild(el('h3', { class: 'priority-bucket-head', style: { textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '12px', color: 'var(--ink-mute, #888)', margin: '14px 0 8px' } }, ['Never beaten']));
        const grid = el('div', { class: 'priority-grid' });
        for (const t of intel.never_beaten) grid.appendChild(priorityRow(t, 'never_beaten', opps));
        wrap.appendChild(grid);
    }

    // Winnable repeat losses
    if (intel.winnable?.length) {
        wrap.appendChild(el('h3', { class: 'priority-bucket-head', style: { textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '12px', color: 'var(--ink-mute, #888)', margin: '18px 0 8px' } }, ['Winnable repeat losses']));
        const grid = el('div', { class: 'priority-grid' });
        for (const t of intel.winnable) grid.appendChild(priorityRow(t, 'winnable', opps));
        wrap.appendChild(grid);
    }

    // Club style gaps
    if (intel.club_loss_pattern?.length) {
        wrap.appendChild(el('h3', { class: 'priority-bucket-head', style: { textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '12px', color: 'var(--ink-mute, #888)', margin: '20px 0 8px' } }, ['Club-style gaps']));
        const cgrid = el('div', { class: 'priority-grid' });
        for (const c of intel.club_loss_pattern) cgrid.appendChild(clubRow(c));
        wrap.appendChild(cgrid);
    }

    // Shared coaching note for parent profile
    if (profile.role === 'parent' && SHARED_PATTERNS?.coaching_implication) {
        wrap.appendChild(el('div', { class: 'card', style: { marginTop: '20px', borderLeft: '3px solid var(--gold, #c9a86a)' } }, [
            el('div', { class: 'kicker', style: { marginBottom: '6px' } }, ['Coaching implication']),
            el('p', { style: { margin: 0 } }, [SHARED_PATTERNS.coaching_implication])
        ]));
    }

    return wrap;
}

function priorityRow(t, bucket, opps) {
    const matched = findOppByName(opps, t.name);
    const recordCls = bucket === 'never_beaten' ? 'priority-record-cold' : 'priority-record-warm';
    const priorityDot = t.priority === 'high' ? '●' : (t.priority === 'med' ? '◐' : '○');

    const row = el('div', {
        class: 'priority-card',
        style: {
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
            padding: '14px 16px', marginBottom: '8px',
            background: 'var(--surface, #15140f)',
            borderRadius: '12px', gap: '12px'
        }
    }, [
        el('div', { style: { flex: '1 1 auto', minWidth: 0 } }, [
            el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } }, [
                el('span', { style: { fontSize: '11px', color: 'var(--ink-mute, #888)' } }, [priorityDot]),
                el('span', { class: 'opp-name', style: { fontWeight: 600 } }, [t.name]),
                t.rating ? el('span', { class: 'tag', style: { fontSize: '10px' } }, [t.rating]) : null
            ]),
            el('div', { class: 'opp-club', style: { fontSize: '13px', color: 'var(--ink-soft, #999)', marginTop: '2px' } }, [t.club || '—']),
            t.note ? el('div', { class: 'kicker', style: { marginTop: '6px', fontStyle: 'italic', color: 'var(--ink-mute, #aaa)' } }, [t.note]) : null,
            el('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
                matched
                    ? el('a', {
                        href: `#opponents/show?id=${matched.id}`, class: 'btn btn-ghost btn-sm',
                        style: { fontSize: '12px', padding: '4px 10px' }
                    }, [matched.style_profile ? 'Open profile' : 'Profile this fencer'])
                    : el('button', {
                        type: 'button', class: 'btn btn-ghost btn-sm',
                        style: { fontSize: '12px', padding: '4px 10px' },
                        onclick: () => onAddPriorityTarget(t)
                    }, ['+ Add to scout list'])
            ])
        ]),
        el('div', {
            class: recordCls,
            style: {
                fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--mono, ui-monospace, monospace)',
                fontSize: '15px', fontWeight: 600, whiteSpace: 'nowrap'
            }
        }, [t.record])
    ]);
    return row;
}

function clubRow(c) {
    return el('div', {
        class: 'priority-club',
        style: {
            padding: '12px 16px', marginBottom: '8px',
            background: 'var(--surface-2, #1a1812)',
            borderRadius: '12px'
        }
    }, [
        el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline' } }, [
            el('div', { style: { fontWeight: 600 } }, [c.club]),
            el('div', { style: { fontFamily: 'var(--mono, ui-monospace, monospace)', fontVariantNumeric: 'tabular-nums', fontSize: '14px' } },
                [`${c.w}–${c.l}`])
        ]),
        c.tag ? el('div', { class: 'kicker', style: { marginTop: '4px', fontSize: '12px', color: 'var(--ink-mute, #aaa)' } }, [noEmoji(c.tag)]) : null,
        c.notable_fencers?.length
            ? el('div', { style: { marginTop: '6px', fontSize: '12px', color: 'var(--ink-soft, #999)' } },
                [c.notable_fencers.join(' · ')])
            : null
    ]);
}

async function onAddPriorityTarget(t) {
    try {
        const profile = activeProfile();
        if (!profile) { toast('Pick a profile first', 'error'); return; }
        // Derive starting record W/L from the FT record string e.g. "0-7"
        const m = (t.record || '').match(/^(\d+)-(\d+)$/);
        const wins = m ? Number(m[1]) : 0;
        const losses = m ? Number(m[2]) : 0;
        const { data, error } = await supa
            .from('opponents')
            .insert({
                profile_id: profile.id,
                name: t.name,
                club: t.club || null,
                rating: t.rating || null,
                is_priority_target: true,
                style_profile: null
            })
            .select()
            .single();
        if (error) throw error;
        toast(`Added ${t.name} to Scout`);
        go('opponents/show', { id: data.id });
    } catch (e) {
        toast('Add failed: ' + e.message, 'error');
    }
}

// =====================================================
// STYLE-PROFILE interview — exposed for opponent detail
// =====================================================
export function styleProfileEditor(opp, onSave) {
    const initial = opp.style_profile || {};
    const wrap = el('section', { class: 'style-profile' });

    wrap.appendChild(el('div', { class: 'section-head' }, [
        el('h2', {}, ['Style profile']),
        el('span', { class: 'meta' }, [
            opp.style_profile
                ? `${Object.keys(opp.style_profile).filter((k) => opp.style_profile[k]).length}/${STYLE_QUESTIONS.length} answered`
                : 'not started'
        ])
    ]));

    wrap.appendChild(el('p', { class: 'kicker', style: { marginBottom: '14px' } }, [
        'Quick interview. Answer what you know — skip the rest. Saves on every keystroke.'
    ]));

    const values = { ...initial };
    let saveTimer;

    function debouncedSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            try {
                await safeWrite({ table: 'opponents', op: 'update', payload: { style_profile: values }, match: { id: opp.id } });
                if (onSave) onSave(values);
                toast('Saved');
            } catch (e) { toast('Save failed: ' + e.message, 'error'); }
        }, 700);
    }

    for (const q of STYLE_QUESTIONS) {
        const ta = el('textarea', {
            rows: 2, name: q.slug, class: 'field-input',
            placeholder: q.hint,
            oninput: (e) => { values[q.slug] = e.target.value; debouncedSave(); }
        });
        ta.value = initial[q.slug] || '';
        wrap.appendChild(el('div', { class: 'field' }, [
            el('label', { class: 'field-label' }, [q.label]),
            ta,
            el('div', { class: 'kicker', style: { marginTop: '4px', fontSize: '11px', opacity: 0.65 } }, [q.hint])
        ]));
    }

    return wrap;
}


// =====================================================
// Opponent profiler card — Claude reads the opponent
// =====================================================
function buildOpponentProfilerCard(opp) {
    const wrap = el('section', {
        class: 'coach-card',
        style: {
            margin: '14px var(--gut) 8px', padding: '22px 24px',
            background: 'var(--surface)', borderRadius: 'var(--r-card, 18px)',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.04)'
        }
    });
    const head = el('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }
    }, [
        el('div', { class: 'metric-label' }, ['Claude\'s read']),
        el('div', { class: 'meta', style: { fontSize: '11px', color: 'var(--ink-mute)' } }, ['style + opening plan'])
    ]);
    wrap.appendChild(head);

    const body = el('div', { class: 'coach-card-body' });
    wrap.appendChild(body);

    renderEmpty();

    function renderEmpty() {
        body.innerHTML = '';
        body.appendChild(el('p', {
            style: { margin: '6px 0 14px', color: 'var(--ink-mute)', fontStyle: 'italic' }
        }, [`A starter style read on ${opp.name} plus a 30-second opening-touch plan.`]));
        body.appendChild(el('button', {
            type: 'button', class: 'btn btn-primary',
            onclick: handleGenerate
        }, ['Get Claude\'s read']));
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
        }, [model || 'claude']));
        body.appendChild(el('div', { style: { marginTop: '12px' } }, [
            el('button', {
                type: 'button', class: 'btn btn-ghost btn-sm',
                style: { fontSize: '12px' }, onclick: handleGenerate
            }, ['Regenerate'])
        ]));
    }
    function renderError(msg) {
        body.innerHTML = '';
        body.appendChild(el('p', { style: { color: 'var(--loss)' } }, ['Could not get profile: ' + msg]));
        body.appendChild(el('button', {
            type: 'button', class: 'btn btn-ghost btn-sm',
            onclick: handleGenerate
        }, ['Try again']));
    }
    async function handleGenerate() {
        renderLoading();
        try {
            const res = await opponentProfiler(opp.id);
            if (res?.text) renderResponse(res.text, res.model);
            else renderError('empty response');
        } catch (e) {
            renderError(e.message || String(e));
        }
    }

    // Show cached profile if one exists
    (async () => {
        try {
            const notes = await listCoachNotes({ kind: 'opponent-profiler', opponentId: opp.id, limit: 1 });
            if (notes[0]) renderResponse(notes[0].response_text, notes[0].model);
        } catch (_) { /* ignore */ }
    })();

    return wrap;
}


// =====================================================
// Phase 2 — Color-code priority cards by rating tier
// =====================================================
function tagPriorityCardsByTier() {
    document.querySelectorAll('.priority-card').forEach(card => {
        const text = card.textContent || '';
        const m = text.match(/\b([A-EU])\d{2}\b/);
        const letter = m ? m[1].toUpperCase() : 'U';
        // remove old tier classes
        card.classList.remove('tier-A','tier-B','tier-C','tier-D','tier-E','tier-U');
        card.classList.add('tier-' + letter);
        // Find a rating-looking span and wrap with badge if not already
        // (Lighter touch — skip wrap, the border-left + future enhancement is enough)
    });
}

// Auto-tag priority cards whenever the DOM updates (safety net)
if (typeof MutationObserver !== 'undefined') {
    const _ptObs = new MutationObserver(() => tagPriorityCardsByTier());
    _ptObs.observe(document.body, { childList: true, subtree: true });
}


// =====================================================
// Phase: FT Intel — show tactical insights for this opponent (if matched)
// =====================================================
async function buildFtIntelPanel(opp) {
    const intel = await getIntel(opp?.name);
    if (!intel) return null;
    const wrap = document.createElement('section');
    wrap.className = 'ft-intel-panel';
    const ranks = ['y14','cadet','junior']
        .filter(k => intel.ranks?.[k])
        .map(k => `<span class="ft-rank-pill ft-rank-${k}">${k.toUpperCase()} #${intel.ranks[k]}</span>`).join('');

    // NEW: actionable plays (sorted by priority) — tag / data / game_plan / cue
    const plays = [...(intel.plays || [])].sort((a,b) => (a.priority||99) - (b.priority||99));
    const playsHtml = plays.map(p => `
        <article class="ft-play-card ft-play-p${p.priority || 3}">
            <header class="ft-play-tag">${noEmoji(p.tag)}</header>
            ${p.data ? `<div class="ft-play-data">${p.data}</div>` : ''}
            ${p.game_plan ? `
                <div class="ft-play-row">
                    <span class="ft-play-label">Game plan</span>
                    <p class="ft-play-text">${noEmoji(p.game_plan)}</p>
                </div>` : ''}
            ${p.cue ? `
                <div class="ft-play-row ft-play-cue">
                    <span class="ft-play-label">In-bout cue</span>
                    <p class="ft-play-text">${noEmoji(p.cue)}</p>
                </div>` : ''}
        </article>
    `).join('');

    // Legacy fallback if an entry still uses key_insights
    const legacyInsights = (!plays.length && Array.isArray(intel.key_insights))
        ? `<ul class="ft-insights">${intel.key_insights.map(i => `<li>${i}</li>`).join('')}</ul>` : '';

    const vsTier = Object.entries(intel.vs_tier || {})
        .filter(([t,v]) => v.w+v.l > 0 && t !== 'U')
        .map(([t,v]) => `<div class="ft-tier-row"><span class="ft-tier-badge ft-tier-${t}">${t}</span><span class="ft-tier-record">${v.w}-${v.l}</span><span class="ft-tier-pct">${v.pct}%</span></div>`).join('');
    const last5 = (intel.recent_5 || []).map(b => `<li>${b.date || '?'} · ${b.round || '?'} · <strong class="${b.result==='V'?'r-win':'r-loss'}">${b.result} ${b.score}</strong> · vs ${b.opp_rating || '?'}</li>`).join('');
    const pt = intel.pool_touches;
    const cb = intel.close_bouts;
    const days = intel.days_since_last_bout;
    // The intel data carries emoji and shouty caps from an older design; the
    // page speaks in the site's voice, so strip them at render time.
    const headlinePlan = intel.headline_plan ? `<div class="ft-intel-headline-plan">${noEmoji(intel.headline_plan)}</div>` : '';
    const headline = intel.headline ? noEmoji(intel.headline) : '';
    wrap.innerHTML = `
        <div class="ft-intel-head">
            <span class="ft-intel-label">Scout intel · from his results</span>
            <div class="ft-intel-ranks">${ranks}</div>
            <a class="ft-intel-link" href="${intel.ft_url}" target="_blank" rel="noopener">Profile ↗</a>
        </div>
        ${headline ? `<div class="ft-intel-headline">${headline}</div>` : (intel.tagline ? `<div class="ft-intel-tagline">${noEmoji(intel.tagline)}</div>` : '')}
        ${headlinePlan}
        ${playsHtml ? `<div class="ft-plays-stack">${playsHtml}</div>` : legacyInsights}
        <div class="ft-intel-grid">
            <div class="ft-stat">
                <div class="ft-stat-label">Career bouts</div>
                <div class="ft-stat-value">${intel.career_bouts}</div>
                <div class="ft-stat-sub">${Math.round((intel.career_win_rate||0)*100)}% won</div>
            </div>
            <div class="ft-stat">
                <div class="ft-stat-label">Recent pools</div>
                <div class="ft-stat-value">${intel.recent_record.pool.pct}%</div>
                <div class="ft-stat-sub">${intel.recent_record.pool.w}–${intel.recent_record.pool.l}</div>
            </div>
            <div class="ft-stat">
                <div class="ft-stat-label">Recent DE</div>
                <div class="ft-stat-value">${intel.recent_record.de.pct}%</div>
                <div class="ft-stat-sub">${intel.recent_record.de.w}–${intel.recent_record.de.l}</div>
            </div>
            ${cb && cb.total ? `<div class="ft-stat">
                <div class="ft-stat-label">Decided by one touch</div>
                <div class="ft-stat-value">${cb.w}–${cb.l}</div>
                <div class="ft-stat-sub">${cb.total} bouts</div>
            </div>` : ''}
            ${pt ? `<div class="ft-stat">
                <div class="ft-stat-label">Pool average</div>
                <div class="ft-stat-value">${pt.avg_for}–${pt.avg_against}</div>
                <div class="ft-stat-sub">for and against</div>
            </div>` : ''}
            ${days !== undefined ? `<div class="ft-stat">
                <div class="ft-stat-label">Last bout</div>
                <div class="ft-stat-value">${days}d</div>
                <div class="ft-stat-sub">ago</div>
            </div>` : ''}
        </div>
        ${vsTier ? `<details class="ft-tier-block"><summary>Against each rating · lifetime</summary><div class="ft-tier-list">${vsTier}</div></details>` : ''}
        ${last5 ? `<details class="ft-last5-block"><summary>Last five ranked bouts</summary><ul class="ft-last5">${last5}</ul></details>` : ''}
    `;
    return wrap;
}

