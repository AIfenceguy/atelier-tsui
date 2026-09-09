// Dashboard — "Today" landing.
// Editorial layout per the new design system: italic greeting, caps-mono labels,
// metric-grid for status, bout-card timeline for recent bouts.

import { el, todayISO, fmtDate, fmtDateLong, daysUntil, toast } from '../lib/util.js';
import { activeProfile } from '../lib/state.js';
import { computeAbilities, recentDailyXp, paceProjection, ABILITIES, ABILITY_META, targetLevelFor, SUMMER_NATIONALS_DATE, daysUntil as daysUntilLevels, computeStreak } from '../lib/levels.js';
import { generateCoachTips } from '../lib/coach-ai.js';
import { maybeShowLevelUp } from '../lib/level-up-modal.js';
import { earnedMilestones, MILESTONES } from '../lib/milestones.js';
import {
    nextTournament, getPhysicalForDate, getMentalForDate,
    listBouts, listOpponents, listAllProfiles, fetchXpInputs
} from '../lib/db.js';
import { todayCoachCard, listCoachNotes } from '../lib/coach.js';
import { supa } from '../lib/supa.js';
import { buildWeeklyCoachSummary, renderCoachCard } from '../lib/drill-coach.js';
import { pickDailyTip, renderDailyTip } from '../lib/daily-tip.js';
import { loadWeeklyPlan, weekSummary } from '../lib/weekly-plan.js';

export async function mountDashboard(root) {
    const profile = activeProfile();
    if (!profile) {
        root.appendChild(el('div', { class: 'empty' }, [
            el('p', { class: 'empty-line' }, ['Pick a profile to begin the day.'])
        ]));
        return;
    }

    const date = todayISO();
    const [nextT, phys, ment, recentBouts, opps] = await Promise.all([
        nextTournament(),
        getPhysicalForDate(date),
        getMentalForDate(date),
        listBouts({ limit: 5 }),
        listOpponents()
    ]);

    // Hero — italic greeting + caps-mono date strip
    const heroSubBits = [el('span', {}, [fmtDateLong(date)])];
    if (nextT) {
        const d = daysUntil(nextT.start_date);
        const tName = nextT.name.length > 22 ? nextT.name.slice(0, 20) + '…' : nextT.name;
        heroSubBits.push(el('span', {}, [
            el('b', {}, [tName]),
            ' · ',
            d === 0 ? 'today' : (d === 1 ? '1 day' : `${d} days`)
        ]));
    }
    // Active profile streak — small badge for the hero
    let activeStreak = 0;
    try { const myInputs = await fetchXpInputs(profile.id); activeStreak = computeStreak(myInputs).streak; } catch(e){}
    const heroBitsWithStreak = [...heroSubBits];
    if (activeStreak > 0) heroBitsWithStreak.unshift(el('span', { class: 'hero-streak' }, [String(activeStreak), '-day streak']));

    root.appendChild(el('div', { class: 'today-hero stagger' }, [
        el('h1', { class: 'today-greeting' }, [
            greeting(), ', ',
            el('span', { class: 'accent' }, [profile.name]),
            '.'
        ]),
        el('div', { class: 'today-sub' }, heroBitsWithStreak)
    ]));

    // One thing today — the tip a parent acts on, above every number.
    try {
        root.appendChild(renderDailyTip(await pickDailyTip(profile)));
    } catch (e) { console.warn('Daily tip skipped:', e); }

    // The week's score: sessions done against the three asks (Bouts, Body, Mind).
    try {
        const plans = await loadWeeklyPlan(profile);
        const { done, target } = weekSummary(plans);
        const MUTE = '#6B7280';
        root.appendChild(el('div', { style: { display: 'flex', gap: '14px', alignItems: 'baseline', flexWrap: 'wrap', padding: '0 var(--gut) 14px' } }, [
            el('span', { class: 'label', style: { color: MUTE } }, ['This week']),
            el('span', { class: 'num', style: { color: done >= target ? '#1f7a1f' : 'var(--ink)', fontWeight: '700', fontSize: '16px' } }, [`${done} of ${target} sessions`]),
            ...plans.map((p) => el('a', { href: p.href || '#train', class: 'label', style: { color: (p.checkins || []).length >= p.target_n ? '#1f7a1f' : MUTE, textDecoration: 'none' } }, [
                `${p.area === 'bout' ? 'Bouts' : p.area === 'body' ? 'Body' : 'Mind'} ${Math.min(p.target_n, (p.checkins || []).length)}/${p.target_n}`
            ]))
        ]));
    } catch (e) { console.warn('Week summary skipped:', e); }

    // Status metrics (Body / Mind) — two-column metric grid
    const bodyMetric = phys
        ? {
            val: `${(phys.drills_completed || []).filter((d) => d.done).length}/${(phys.drills_completed || []).length || '–'}`,
            foot: phys.energy_1_10 ? `energy ${phys.energy_1_10}/10` : 'logged'
        }
        : { val: '—', foot: 'no log yet' };
    const mindMetric = ment
        ? {
            val: `${[ment.visualization_done, ment.breathing_done, ment.in_bout_cue_practice].filter(Boolean).length}/3`,
            foot: (ment.scenarios_rehearsed || []).length
                ? `${(ment.scenarios_rehearsed || []).length} scenarios rehearsed`
                : 'logged'
        }
        : { val: '—', foot: 'no log yet' };

    root.appendChild(el('div', { class: 'metric-grid' }, [
        metricCell('TODAY · BODY', bodyMetric.val, bodyMetric.foot, '#physical'),
        metricCell('TODAY · MIND', mindMetric.val, mindMetric.foot, '#mental')
    ]));

    // Season plan — the next weekend worth the money, and the way to the rest.
    // The bottom nav is twelve tabs wide; this is the front door to that screen.
    try {
        const seasonCard = await buildSeasonCard(profile);
        if (seasonCard) root.appendChild(seasonCard);
    } catch (e) { console.warn('Season card skipped:', e); }

    // Level dashboard — gamified XP across both kids
    try {
        const levelSection = await buildLevelDashboard();
        if (levelSection) root.appendChild(levelSection);
    } catch (e) {
        console.warn('Level dashboard skipped:', e);
    }

    // AI Coach training tips — generated from bouts + lessons
    try {
        const coachSection = await buildAICoachSection(profile);
        if (coachSection) root.appendChild(coachSection);

        // Phase 3 — Drill mastery weekly coach card
        try {
            const summary = await buildWeeklyCoachSummary(profile);
            if (summary && summary.length) {
                root.appendChild(renderCoachCard(el, summary, profile));
            }
        } catch (e) { console.warn('[drill-coach] build failed', e); }
    } catch (e) { console.warn('AI coach skipped:', e); }

    // Coaching card — today's Foil-IQ focus, generated by Claude
    root.appendChild(buildCoachingCard(profile, date));

    // Recent bouts — editorial timeline
    if (recentBouts.length) {
        root.appendChild(el('div', { class: 'label-row', style: { marginTop: '28px' } }, [
            el('span', { class: 'label' }, ['Recent bouts']),
            el('a', { href: '#bouts', class: 'label label-gold', style: { textDecoration: 'none' } }, ['VIEW ALL →'])
        ]));
        for (const b of recentBouts) {
            root.appendChild(boutCard(b));
        }
    } else {
        root.appendChild(el('div', { class: 'empty', style: { marginTop: '20px' } }, [
            el('p', { class: 'empty-line' }, ['Today is quiet. The first bout opens the journal.']),
            el('a', { href: '#bouts/new', class: 'btn btn-primary btn-mono-label empty-cta' }, ['Log a bout'])
        ]));
    }

    // Scout quick-look — small chip row
    if (opps.length) {
        root.appendChild(el('div', { class: 'label-row', style: { marginTop: '28px' } }, [
            el('span', { class: 'label' }, ['Scout · recent']),
            el('a', { href: '#opponents', class: 'label label-gold', style: { textDecoration: 'none' } }, ['VIEW ALL →'])
        ]));
        root.appendChild(el('div', { class: 'chip-row', style: { padding: '0 var(--gut)' } }, opps.slice(0, 6).map((o) =>
            el('a', { href: `#opponents/show?id=${o.id}`, class: 'chip', style: { textDecoration: 'none' } }, [o.name])
        )));
    }

    // Quick log row — at the bottom, restrained
    root.appendChild(el('div', { style: { padding: '32px var(--gut) 16px' } }, [
        el('div', { class: 'label', style: { marginBottom: '14px' } }, ['Quick log']),
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
            el('a', { href: '#bouts/new', class: 'btn btn-primary btn-mono-label' }, ['+ Bout']),
            el('a', { href: '#physical', class: 'btn btn-ghost btn-mono-label' }, ['Body']),
            el('a', { href: '#mental', class: 'btn btn-ghost btn-mono-label' }, ['Mind']),
            el('a', { href: '#lessons', class: 'btn btn-ghost btn-mono-label' }, ['Lesson'])
        ])
    ]));

    // Foot — small links to admin areas
    root.appendChild(el('div', { class: 'foil-divider' }));
    root.appendChild(el('div', { style: { display: 'flex', gap: '20px', justifyContent: 'center', padding: '0 var(--gut) 28px' } }, [
        el('a', { href: '#tournaments', class: 'label', style: { textDecoration: 'none' } }, ['Tournaments →']),
        el('a', { href: '#import-v1', class: 'label', style: { textDecoration: 'none' } }, ['Import v1 →'])
    ]));
}

function greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
}

function metricCell(label, val, foot, href) {
    return el('a', { href, class: 'metric', style: { textDecoration: 'none', color: 'inherit' } }, [
        el('div', { class: 'metric-label' }, [label]),
        el('div', { class: 'metric-val' }, [val]),
        el('div', { class: 'metric-foot' }, [foot])
    ]);
}

// =====================================================
// Coaching card — Today's Foil-IQ focus, served by Claude
// =====================================================
function buildCoachingCard(profile, date) {
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
        el('div', { class: 'metric-label' }, ['Today · coaching card']),
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
        }, [`A focus, a warm-up cue, and one drill — tailored to ${profile.name}'s recent pattern.`]));
        body.appendChild(el('button', {
            type: 'button',
            class: 'btn btn-primary',
            onclick: handleGenerate
        }, ['Get today\'s card']));
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
        }, [`generated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${model || 'claude'}`]));
        body.appendChild(el('div', { style: { marginTop: '12px' } }, [
            el('button', {
                type: 'button',
                class: 'btn btn-ghost btn-sm',
                style: { fontSize: '12px' },
                onclick: handleGenerate
            }, ['Regenerate'])
        ]));
    }

    function renderError(msg) {
        body.innerHTML = '';
        body.appendChild(el('p', { style: { color: 'var(--loss)' } }, ['Could not get coaching card: ' + msg]));
        body.appendChild(el('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            onclick: handleGenerate
        }, ['Try again']));
    }

    async function handleGenerate() {
        renderLoading();
        try {
            const res = await todayCoachCard();
            if (res?.text) {
                renderResponse(res.text, res.model);
            } else {
                renderError('empty response');
            }
        } catch (e) {
            renderError(e.message || String(e));
        }
    }

    // On mount, look for today's already-generated card and show it without spending a fresh call
    (async () => {
        try {
            const notes = await listCoachNotes({ kind: 'today-coach-card', limit: 1 });
            const latest = notes[0];
            if (latest && latest.created_at?.slice(0, 10) === date) {
                renderResponse(latest.response_text, latest.model);
            }
        } catch (_) { /* ignore — fall through to empty state */ }
    })();

    return wrap;
}

// Render a single bout as the editorial card with sparkline + quote
function boutCard(b) {
    const my = b.my_score ?? 0;
    const their = b.their_score ?? 0;
    const isWin = b.outcome === 'win';
    const isLoss = b.outcome === 'loss';

    // Touch strip — render `their` ghost ticks + `my` scored ticks; if the last
    // scoring action has a 'flick' tag, render the final tick as a flick mark.
    const total = my + their;
    const ticks = [];
    for (let i = 0; i < total; i++) {
        ticks.push(el('span', { class: i < my ? 'touch-tick is-scored' : 'touch-tick' }));
    }
    // Mark the last scored tick as a flick if the action says so
    const acts = Array.isArray(b.scoring_actions) ? b.scoring_actions : [];
    const lastAct = acts.length ? acts[acts.length - 1] : null;
    if (lastAct && /flick/i.test(lastAct.tactic_slug || '') && my > 0) {
        // Replace the last scored tick (the my-th tick at index my-1) with flick
        if (ticks[my - 1]) {
            ticks[my - 1] = el('span', { class: 'touch-tick is-flick' });
        }
    }

    // Tag row — opponent rating + archetypes
    const tags = [];
    if (b.opponent_rating) tags.push(el('span', { class: 'bout-card-opp-tag' }, [b.opponent_rating]));
    (b.opponent_archetypes || []).forEach((a) => tags.push(el('span', { class: 'bout-card-opp-tag' }, [a])));
    if (b.opponent_club) tags.push(el('span', { class: 'bout-card-opp-tag' }, [b.opponent_club]));

    const meta = [];
    meta.push(el('span', {}, [fmtDate(b.date).toUpperCase()]));
    if (b.context) meta.push(el('span', {}, [String(b.context).replace(/_/g, ' ').toUpperCase()]));
    if (b.location) meta.push(el('span', {}, [b.location.toUpperCase()]));

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
// Level dashboard — Strike / Guard / Engine / Mind for both kids
// =====================================================
async function buildLevelDashboard() {
    // A fencer's page shows that fencer alone. The parent profile shows every
    // fencer on the account side by side. A kid's login only ever receives his
    // own profile from the database, so he cannot see a sibling here.
    const allProfiles = await listAllProfiles();
    const fencers = allProfiles.filter(p => p.kind === 'fencer' || p.role === 'raedyn' || p.role === 'kaylan');
    const active = activeProfile();
    const kids = active && fencers.some(p => p.id === active.id) ? fencers.filter(p => p.id === active.id) : fencers;
    if (!kids.length) return null;

    const inputsByKid = await Promise.all(kids.map(p => fetchXpInputs(p.id)));
    const abilitiesByKid = inputsByKid.map(d => computeAbilities(d));
    const recentByKid = inputsByKid.map(d => recentDailyXp(d, 7));

    // Pace against the next real event on the calendar, not a fixed date.
    // Falls back to the coming Summer Nationals if nothing is scheduled.
    let paceName = 'Summer Nationals';
    let paceDate = SUMMER_NATIONALS_DATE;
    try {
        const { data: nextEv } = await supa
            .from('events').select('name,event_date')
            .gte('event_date', todayISO()).order('event_date').limit(1);
        if (nextEv?.[0]) { paceName = nextEv[0].name; paceDate = nextEv[0].event_date; }
    } catch (_) { /* fall back */ }
    const days = daysUntilLevels(paceDate);

    // Check for level-ups since last load (per kid)
    kids.forEach((kid, i) => {
        try { maybeShowLevelUp(kid.id, abilitiesByKid[i]); } catch (e) {}
    });

    const wrap = el('section', { class: 'level-dash stagger' });

    wrap.appendChild(el('div', { class: 'label-row', style: { marginTop: '32px' } }, [
        el('span', { class: 'label' }, [`Your stats · pace to ${paceName}`]),
        el('span', { class: 'label', style: { color: '#6B7280' } }, [
            days === 0 ? 'today' : `${days} day${days===1?'':'s'}`
        ])
    ]));

    const grid = el('div', { class: 'level-grid' });
    kids.forEach((kid, i) => {
        const abilities = abilitiesByKid[i];
        const recent = recentByKid[i];
        const streak = computeStreak(inputsByKid[i]);
        const avatarTile = el('div', {
            class: 'avatar-tile avatar-initial',
            style: { '--accent': kid.accent_hex || 'var(--gold)' }
        }, [String(kid.name || '?').trim().charAt(0).toUpperCase()]);
        const earned = earnedMilestones(inputsByKid[i]);
        const earnedSet = new Set(earned.map(m => m.id));
        const card = el('div', { class: 'level-card', style: { borderTop: `4px solid ${kid.accent_hex || '#888'}` } }, [
            el('div', { class: 'level-card-head' }, [
                avatarTile,
                el('div', { class: 'level-card-titles' }, [
                    el('div', { class: 'level-name' }, [kid.name]),
                    el('div', { class: 'level-meta' }, [
                        el('span', { class: 'streak-pill', title: 'Days logged in a row' }, [String(streak.streak), '-day streak']),
                        el('span', { class: 'badges-pill', title: 'Milestones earned' }, [String(earned.length), ' of ', String(MILESTONES.length), ' milestones'])
                    ])
                ])
            ]),
            el('div', { class: 'badge-strip', title: 'Milestone badges (faded = locked)' }, MILESTONES.slice(0, 13).map(m =>
                el('span', { class: 'badge-stamp ' + (earnedSet.has(m.id) ? 'is-earned' : 'is-locked'), title: m.name }, [m.mark || ''])
            ))
        ]);
        for (const k of ABILITIES) {
            card.appendChild(abilityRow(k, abilities[k], recent[k], days));
        }
        grid.appendChild(card);
    });
    wrap.appendChild(grid);

    return wrap;
}

function abilityRow(key, ability, dailyXp, days) {
    const meta = ABILITY_META[key];
    const target = targetLevelFor(key);
    const pace = paceProjection(ability, dailyXp || 0, target, days);
    // Copy for an athlete's stat sheet, not an arcade. States are named the
    // way a coach would name them, and a past target date says so rather than
    // printing a non-number.
    const perDay = pace.xpPerDayNeeded == null ? null : `${pace.xpPerDayNeeded} XP/day`;
    const paceText =
        pace.status === 'done'        ? `Target reached · Lv ${target}` :
        pace.status === 'not_started' ? `Nothing logged yet · target Lv ${target}` :
        pace.pastDate                 ? `Target date passed · Lv ${target} not reached` :
        pace.status === 'on_track'    ? `On pace · ${Math.round(dailyXp)} XP/day` :
        pace.status === 'close'       ? `Close · needs ${perDay} for Lv ${target}` :
                                        `Behind · needs ${perDay} for Lv ${target}`;
    const paceClass =
        pace.status === 'done' || pace.status === 'on_track' ? 'is-good' :
        pace.status === 'close' ? 'is-close' :
        pace.status === 'not_started' ? 'is-idle' : 'is-behind';
    return el('div', { class: `ability-row tier-${ability.rank.tier} ${key}`, 'data-ability': key }, [
        el('div', { class: 'ability-head' }, [
            el('span', { class: 'level-badge' }, [
                el('span', { class: 'level-lv' }, ['LV']),
                el('span', { class: 'level-num' }, [String(ability.level)])
            ]),
            el('div', { class: 'ability-icon-name' }, [
                el('span', { class: 'ability-label' }, [meta.label])
            ])
        ]),
        el('div', { class: 'ability-bar' }, [
            el('div', {
                class: 'ability-fill',
                style: { width: ability.pctToNext + '%', background: ability.rank.color }
            })
        ]),
        el('div', { class: 'ability-foot' }, [
            el('span', { class: 'ability-xp' }, [
                String(ability.xpToNext), ' / 100 XP'
            ]),
            el('span', { class: 'ability-pace ' + paceClass }, [paceText])
        ])
    ]);
}


// =====================================================
// AI Coach — quantified training tips for the active profile
// =====================================================
async function buildAICoachSection(profile) {
    const data = await fetchXpInputs(profile.id);
    const result = generateCoachTips(data);
    if (!result.tips.length && !result.reminders.length) return null;

    const wrap = el('section', { class: 'coach-tips stagger', style: { padding: '0 var(--gut)', marginTop: '28px' } });
    wrap.appendChild(el('div', { class: 'label-row' }, [
        el('span', { class: 'label' }, ['This week · what to work on']),
        el('span', { class: 'label label-gold' }, [
            result.weeklyXpForecast > 0 ? `+${result.weeklyXpForecast} XP this week if every planned session is done` : `${result.boutCount} bouts analyzed`
        ])
    ]));

    for (const tip of result.tips) {
        wrap.appendChild(coachTipCard(tip));
    }
    for (const r of result.reminders) {
        wrap.appendChild(el('div', { class: 'coach-reminder' }, [r]));
    }
    return wrap;
}

function coachTipCard(tip) {
    const card = el('div', { class: `coach-tip coach-tip-p${tip.priority}` });
    card.appendChild(el('div', { class: 'coach-tip-label' }, [tip.label]));
    card.appendChild(el('div', { class: 'coach-tip-title' }, [tip.title]));
    if (tip.from)       card.appendChild(el('div', { class: 'coach-tip-meta' }, [`from ${tip.from} · mastery ${tip.mastery ?? '?'}/10`]));
    if (tip.diagnosis)  card.appendChild(el('div', { class: 'coach-tip-meta' }, [tip.diagnosis]));
    if (tip.coachQuote) card.appendChild(el('blockquote', { class: 'coach-quote' }, [`"${tip.coachQuote}"`]));

    if (tip.drill) {
        const d = tip.drill;
        card.appendChild(el('div', { class: 'coach-drill' }, [
            el('div', { class: 'coach-drill-name' }, [d.name]),
            el('div', { class: 'coach-drill-prescription' }, [
                el('span', {}, [`${d.reps} reps`]),
                el('span', { class: 'sep' }, ['·']),
                el('span', {}, [`${d.sets} sets`]),
                el('span', { class: 'sep' }, ['·']),
                el('span', {}, [`${d.restSec}s rest`]),
                el('span', { class: 'sep' }, ['·']),
                el('span', {}, [d.frequency]),
                el('span', { class: 'sep' }, ['·']),
                el('span', { class: 'xp-badge' }, [`+${d.xpPerSession} XP per session · +${d.xpPerWeek} a week`])
            ])
        ]));
    }
    if (tip.why) card.appendChild(el('div', { class: 'coach-why' }, [`Why: ${tip.why}`]));
    return card;
}

// ---------------------------------------------------------------------------
// Season card: the best-value upcoming weekend for this fencer, from the
// scored season_events rows, ranked the same way the Season screen ranks them.
// ---------------------------------------------------------------------------
async function buildSeasonCard(profile) {
    const today = todayISO();
    const { data } = await supa.from('season_events')
        .select('tournament,start_date,end_date,city,travel,tier,category,est_cost_two,projections')
        .gte('start_date', today).order('start_date').limit(200);
    const rows = (data || []).filter((r) => r.projections && r.projections[profile.name] && r.projections[profile.name].points_exp != null);
    if (!rows.length) return null;
    const trips = new Map();
    for (const r of rows) {
        const key = r.tournament + '|' + String(r.start_date).slice(0, 7);
        const t = trips.get(key) || { tournament: r.tournament, start: r.start_date, end: r.end_date, city: r.city, travel: r.travel, cost: r.est_cost_two || 0, pts: 0, cats: [] };
        t.pts += r.projections[profile.name].points_exp;
        t.start = t.start < r.start_date ? t.start : r.start_date;
        t.end = (t.end || '') > (r.end_date || '') ? t.end : r.end_date;
        t.cats.push(r.category.toUpperCase());
        trips.set(key, t);
    }
    const ranked = [...trips.values()].filter((t) => t.pts >= 8).sort((a, b) => b.pts / Math.max(1, b.cost) - a.pts / Math.max(1, a.cost));
    if (!ranked.length) return null;
    const best = ranked[0];
    const MUTE = '#6B7280';
    const day = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00');
    const span = (!best.end || best.end === best.start)
        ? day(best.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : day(best.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '–' + day(best.end).toLocaleDateString(undefined, { day: 'numeric' });
    const travel = best.travel === 'local' ? 'drive, no hotel' : best.travel === 'drive' ? 'drive' : 'fly';
    return el('a', { href: '#season', class: 'card', style: { display: 'block', margin: '18px var(--gut) 0', textDecoration: 'none', color: 'var(--ink)' } }, [
        el('div', { class: 'label', style: { color: MUTE } }, ['Season · best value weekend']),
        el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '24px', lineHeight: '1.15', margin: '4px 0 2px', color: 'var(--ink)' } }, [best.tournament]),
        el('div', { class: 'label', style: { color: MUTE } }, [[span, best.city, travel].filter(Boolean).join(' · ')]),
        el('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap', margin: '10px 0 8px' } }, [
            el('div', {}, [el('div', { class: 'label', style: { color: MUTE } }, ['Expected points']), el('div', { class: 'num', style: { fontSize: '20px', fontWeight: '600', color: 'var(--ink)' } }, [best.pts.toFixed(0)])]),
            el('div', {}, [el('div', { class: 'label', style: { color: MUTE } }, ['Trip for two']), el('div', { class: 'num', style: { fontSize: '20px', fontWeight: '600', color: 'var(--ink)' } }, ['$' + Math.round(best.cost).toLocaleString()])]),
            el('div', {}, [el('div', { class: 'label', style: { color: MUTE } }, ['Events']), el('div', { class: 'num', style: { fontSize: '20px', fontWeight: '600', color: 'var(--ink)' } }, [best.cats.join(' + ')])])
        ]),
        el('div', { class: 'label', style: { color: 'var(--ink)', fontWeight: '700', textDecoration: 'underline', textUnderlineOffset: '3px' } }, [`See all ${ranked.length} weekends worth going →`])
    ]);
}
