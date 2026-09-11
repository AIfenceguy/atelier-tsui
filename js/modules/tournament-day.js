// Tournament Day Mode — fast bout entry at a real competition.
//
// Workflow:
//   1. Pick the tournament from the Tournaments page → tap "Start Day"
//   2. Set up your pool: enter 5-7 fencers (by hand, FTL paste, or — future — Worker live-fetch)
//   3. Each cell in the pool grid is one bout — tap to log score (5-3, V or D)
//   4. App auto-totals V / TS-TR / indicator for your row
//   5. After pool, "+ Add DE round" lets you log DE bouts as they happen
//
// Each saved bout writes to the existing `bouts` table with a JSON blob in
// `notes` carrying { tournament_id, pool_num, pool_pos, de_round } so the
// dashboard / coach / weak-spot panel keeps working unchanged.

import { el, todayISO, fmtDate, fmtDateLong, toast } from '../lib/util.js';
import { activeProfile } from '../lib/state.js';
import {
    listTournaments, listBouts, listOpponents,
    findOrCreateOpponent
} from '../lib/db.js';
import { safeWrite } from '../lib/offline.js';
import { getIntel } from '../lib/fencer-intel.js';
import { parseFtlText, parseFtlDETableau, normalizeName } from '../lib/ftl-parser.js';

// FTL live-data proxy (Cloudflare Worker). Deployed under Ricky's CF account.
// All comparisons in this module are case-INSENSITIVE per CLAUDE.md rule #7.
const FTL_WORKER_URL = 'https://ftl-proxy.rtsui-jlconcepts.workers.dev';

export async function mountTournamentDay(root, params) {
    const profile = activeProfile();
    if (!profile) return root.appendChild(el('div', { class: 'empty' }, ['Pick a profile.']));

    const tournaments = await listTournaments();
    const tournament = tournaments.find(t => t.id === params.id) || tournaments[0];
    if (!tournament) {
        root.appendChild(el('div', { class: 'empty', style: { padding: '40px var(--gut)' } }, [
            el('p', {}, ['No tournament selected.']),
            el('a', { href: '#tournaments', class: 'btn btn-primary' }, ['Back to Tournaments'])
        ]));
        return;
    }

    // Header
    root.appendChild(el('div', { style: { padding: '40px var(--gut) 8px' } }, [
        el('h1', { class: 'page-eyebrow' }, ['Tournament Day']),
        el('div', { class: 'today-sub' }, [
            el('span', {}, [profile.name.toUpperCase()]),
            el('span', {}, [tournament.name.toUpperCase()])
        ]),
        el('p', { style: { fontFamily: 'var(--eg-mono,monospace)', fontSize: '11px', color: 'var(--ink-mute)', marginTop: '4px' } }, [
            fmtDateLong(tournament.start_date),
            tournament.location ? ` · ${tournament.location}` : ''
        ])
    ]));

    // === Local state held in memory (saved on each bout) ============
    // pool = { fencers: [{name, club, rating, ratingYear, archetypes, intel}],
    //          myIndex: 0,
    //          bouts: { "i-j": {meScore, themScore, V|D, savedId} } }
    let pool = loadPoolFromCache(tournament.id) || newPool();
    const mountPoint = el('div', {});
    root.appendChild(mountPoint);

    render();

    function render() {
        mountPoint.innerHTML = '';
        renderActions(mountPoint);
        if (pool.live) renderLiveStatus(mountPoint);
        if (pool.fencers.length === 0) renderPoolSetup(mountPoint);
        else renderPoolGrid(mountPoint);
        renderDESection(mountPoint);
    }

    function renderLiveStatus(parent) {
        const live = pool.live;
        // Inline-styled status chips (avoids editing style.css which isn't in staging)
        const chipBase = 'display:inline-block;padding:2px 8px;margin:0 6px 4px 0;border-radius:999px;font-family:var(--eg-mono,monospace);font-size:11px;font-weight:700;letter-spacing:0.04em;';
        const chipOk = chipBase + 'background:rgba(34,139,34,0.12);color:#1f7a1f;';
        const chipPending = chipBase + 'background:rgba(107,114,128,0.10);color:#6B7280;';
        const dataChips = [];
        if (live.rosterSize) dataChips.push(el('span', { style: chipOk }, [`✓ roster (${live.rosterSize})`]));
        if (live.poolsRaw) {
            const n = countPoolRounds(live.poolsRaw);
            dataChips.push(el('span', { style: chipOk }, [`✓ pools${n ? ' (' + n + ')' : ''}`]));
        } else { dataChips.push(el('span', { style: chipPending }, ['◌ pools'])); }
        if (live.tableauRaw) {
            const n = countTableauRounds(live.tableauRaw);
            dataChips.push(el('span', { style: chipOk }, [`✓ tableau${n ? ' (T' + n + ')' : ''}`]));
        } else { dataChips.push(el('span', { style: chipPending }, ['◌ tableau'])); }
        const card = el('div', { class: 'td-live-card', style: { margin: '8px var(--gut) 12px' } }, [
            el('div', { class: 'td-live-head' }, [
                el('span', { class: 'td-live-eyebrow' }, ['🔴 LIVE — FROM FTL']),
                el('button', { type: 'button', class: 'td-live-refresh', title: 'Refresh from FTL', onclick: () => getLiveData() }, ['↻'])
            ]),
            el('div', { class: 'td-live-event' }, [live.tournamentName + ' · ' + live.eventName]),
            el('div', { class: 'td-live-me' }, [
                el('strong', {}, [live.me?.name || profile.name]),
                live.me?.club ? el('span', { class: 'td-live-meta' }, [' · ' + live.me.club]) : null,
                live.me?.rating ? el('span', { class: 'td-live-rating' }, [live.me.rating]) : null,
                live.me?.rank && live.me.rank !== '-' ? el('span', { class: 'td-live-meta' }, [' · seed ' + live.me.rank]) : null
            ].filter(Boolean)),
            el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 6px;' }, dataChips),
            live.poolsRaw ? renderLivePoolSummary(live.poolsRaw, live.me?.name)
                          : el('div', { class: 'td-live-meta' }, [`${live.rosterSize} fencers in event roster`]),
            live.tableauRaw ? renderLiveTableauSummary(live.tableauRaw, live.me?.name) : null,
            live.fetched_at ? el('div', { class: 'td-live-meta', style: 'font-size:11px;margin-top:6px;opacity:0.6;' }, [`fetched ${new Date(live.fetched_at).toLocaleTimeString()}`]) : null
        ].filter(Boolean));
        parent.appendChild(card);
    }

    // Defensive: FTL pools/tableau JSON shape varies — probe and render safely.
    function countPoolRounds(raw) {
        if (!raw) return 0;
        if (Array.isArray(raw.rounds)) return raw.rounds.length;
        if (Array.isArray(raw)) return raw.length;
        if (raw.pools) return Array.isArray(raw.pools) ? raw.pools.length : 0;
        return 0;
    }
    function countTableauRounds(raw) {
        // raw shape from /event/tableau (Worker v5+):
        //   { seeding: [{name, seed, advanced, status, ...}], trees: [{numTables, name, ...}] }
        if (!raw) return 0;
        if (raw.trees?.[0]?.numTables) return raw.trees[0].numTables;
        if (Array.isArray(raw.seeding)) return raw.seeding.length;
        return 0;
    }
    function renderLivePoolSummary(raw, myName) {
        // FTL /pools/results/data returns an array of objects with fields:
        //   id, name, place, tie, v, m, vm, ts, tr, ind, prediction, club1, div, country
        // Case-INSENSITIVE name match per CLAUDE.md rule #7.
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
        const myLower = (myName || '').toLowerCase();
        const myTokens = myLower.split(/\s+/).filter(t => t.length >= 3);
        let found = null;
        for (const f of list) {
            const n = (f.name || '').toLowerCase();
            if (myTokens.length && myTokens.every(t => n.includes(t))) { found = f; break; }
        }
        if (!found) {
            return el('div', { class: 'td-live-meta' }, [
                `Pool data fetched — ${list.length} fencers — your row not yet matched`
            ]);
        }
        // Build a compact pool-result card: Place X · V-M · TS/TR · Ind · Status
        const advanced = (found.prediction || '').toLowerCase().includes('advanc');
        const pct = typeof found.vm === 'number' ? Math.round(found.vm * 100) : null;
        const indStr = (found.ind > 0 ? '+' : '') + (found.ind != null ? found.ind : '');
        const statusBg = advanced ? 'rgba(34,139,34,0.15)' : 'rgba(230,57,70,0.12)';
        const statusColor = advanced ? '#1f7a1f' : '#9b2230';
        return el('div', { style: 'margin-top:6px;padding:8px 10px;background:rgba(0,0,0,0.03);border-radius:8px;' }, [
            el('div', { style: 'font-size:11px;color:#6B7280;font-family:var(--eg-mono,monospace);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px;' }, ['Pool round — your row']),
            el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;font-size:14px;' }, [
                el('strong', { style: 'font-size:18px;color:#1A1D24;' }, [`Place ${found.place || '?'}`]),
                el('span', {}, [`${found.v ?? '?'} V — ${(found.m ?? 0) - (found.v ?? 0)} D`]),
                pct != null ? el('span', { style: 'color:#6B7280;' }, [`(${pct}%)`]) : null,
                el('span', {}, [`TS ${found.ts ?? '-'} / TR ${found.tr ?? '-'}`]),
                el('span', { style: 'font-family:var(--eg-mono,monospace);' }, [`Ind ${indStr}`]),
                el('span', { style: `padding:2px 8px;border-radius:999px;background:${statusBg};color:${statusColor};font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;` },
                    [found.prediction || (advanced ? 'Advanced' : 'Eliminated')])
            ].filter(Boolean))
        ]);
    }
    function renderLiveTableauSummary(raw, myName) {
        const list = Array.isArray(raw?.seeding) ? raw.seeding : [];
        const myLower = (myName || '').toLowerCase();
        const myTokens = myLower.split(/\s+/).filter(t => t.length >= 3);
        let me = null;
        for (const f of list) {
            const n = (f.name || '').toLowerCase();
            if (myTokens.length && myTokens.every(t => n.includes(t))) { me = f; break; }
        }
        const tree = raw?.trees?.[0];
        const treeLine = tree ? `${tree.name || 'Primary Tableau'}${tree.numTables ? ' · ' + tree.numTables + ' tables' : ''}` : '';
        if (!me) {
            return el('div', { class: 'td-live-meta', style: 'margin-top:6px;' }, [
                `DE tableau · ${list.length} seeded${treeLine ? ' · ' + treeLine : ''}`
            ]);
        }
        const advanced = !!me.advanced, elim = !!me.elim;
        const status = me.status || (advanced ? 'Advanced' : elim ? 'Eliminated' : 'Pending');
        const statusBg = advanced ? 'rgba(34,139,34,0.15)' : (elim ? 'rgba(230,57,70,0.12)' : 'rgba(107,114,128,0.10)');
        const statusColor = advanced ? '#1f7a1f' : (elim ? '#9b2230' : '#6B7280');
        // De-bouts: parsed bracket path
        const deBouts = raw?.de_bouts;
        const boutRows = [];
        if (deBouts && Array.isArray(deBouts.bouts)) {
            for (const b of deBouts.bouts) {
                let scoreStr;
                if (b.opp_bye) scoreStr = '(walkover)';
                else if (b.my_score != null && b.opp_score != null) scoreStr = `${b.my_score}-${b.opp_score}`;
                else scoreStr = '—';
                const oppSeed = b.opp_seed ? `(${b.opp_seed}) ` : '';
                const oppName = b.opp_bye ? 'BYE' : (b.opp_name || '—');
                const resultIcon = b.won ? '✓' : '✗';
                const resultColor = b.won ? '#1f7a1f' : '#9b2230';
                boutRows.push(el('div', { style: 'display:flex;gap:8px;align-items:baseline;font-size:13px;padding:3px 0;border-top:1px solid rgba(0,0,0,0.06);' }, [
                    el('strong', { style: 'min-width:46px;color:#1A1D24;font-family:var(--eg-mono,monospace);font-size:11px;' }, [b.round]),
                    el('span', { style: 'color:'+resultColor+';font-weight:700;min-width:14px;' }, [resultIcon]),
                    el('span', { style: 'flex:1 1 auto;' }, [oppSeed + oppName]),
                    el('span', { style: 'font-family:var(--eg-mono,monospace);font-size:12px;color:#1A1D24;' }, [scoreStr])
                ]));
            }
        }
        return el('div', { style: 'margin-top:6px;padding:8px 10px;background:rgba(0,0,0,0.03);border-radius:8px;' }, [
            el('div', { style: 'font-size:11px;color:#6B7280;font-family:var(--eg-mono,monospace);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px;' }, ['DE — your path']),
            el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;font-size:14px;margin-bottom:6px;' }, [
                el('strong', { style: 'font-size:18px;color:#1A1D24;' }, [`Seed ${me.seed || '?'}`]),
                me.rating ? el('span', { style: 'font-family:var(--eg-mono,monospace);background:rgba(43,107,255,0.12);color:#2B6BFF;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700;' }, [me.rating]) : null,
                treeLine ? el('span', { style: 'color:#6B7280;font-size:12px;' }, [treeLine]) : null,
                deBouts?.lost_in ? el('span', { style: 'color:#6B7280;font-size:12px;' }, [`lost in ${deBouts.lost_in}`]) : null,
                el('span', { style: `padding:2px 8px;border-radius:999px;background:${statusBg};color:${statusColor};font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;` }, [status])
            ].filter(Boolean)),
            boutRows.length ? el('div', {}, boutRows) : null
        ].filter(Boolean));
    }

    function renderActions(parent) {
        parent.appendChild(el('div', { class: 'td-actions' }, [
            el('button', {
                class: 'btn btn-ghost btn-sm',
                onclick: () => {
                    if (!confirm('Reset this pool? Your saved bouts stay in BOUTS.')) return;
                    pool = newPool();
                    savePoolToCache(tournament.id, pool);
                    render();
                }
            }, ['Reset pool']),
            el('button', {
                class: 'btn btn-ghost btn-sm',
                onclick: openPasteModal
            }, ['📋 Paste from FTL']),
            el('button', {
                class: 'btn btn-primary btn-sm',
                onclick: () => getLiveData()
            }, ['🔴 Get live data'])
        ]));
    }

    function renderPoolSetup(parent) {
        parent.appendChild(el('div', { class: 'td-section' }, [
            el('h2', { class: 'td-h2' }, ['Set up your pool']),
            el('p', { class: 'td-help' }, [
                'Enter 4–7 fencers in your pool, including yourself. The first fencer is treated as ',
                el('strong', {}, [profile.name]),
                ' — your row stays at the top.'
            ])
        ]));

        // Fencer entry inputs
        const inputArea = el('div', { class: 'td-input-area' });
        const fencerInputs = [];

        function addFencerRow(prefill = {}) {
            const i = fencerInputs.length;
            const isMe = i === 0;
            const nameInput = el('input', {
                type: 'text', class: 'td-input td-input-name',
                placeholder: isMe ? `${profile.name} (you)` : 'Fencer name',
                value: isMe ? profile.name : (prefill.name || '')
            });
            if (isMe) nameInput.disabled = true;
            const clubInput = el('input', {
                type: 'text', class: 'td-input td-input-club',
                placeholder: 'Club', value: prefill.club || ''
            });
            const ratingInput = el('input', {
                type: 'text', class: 'td-input td-input-rating',
                placeholder: 'A26', value: prefill.rating || '', maxlength: 4,
                style: { textTransform: 'uppercase', width: '64px' }
            });
            const row = el('div', { class: 'td-fencer-row' }, [
                el('span', { class: 'td-pos' }, [String(i + 1)]),
                nameInput, clubInput, ratingInput,
                i > 0 ? el('button', {
                    type: 'button', class: 'td-rm',
                    onclick: () => {
                        const idx = fencerInputs.indexOf(group);
                        fencerInputs.splice(idx, 1);
                        row.remove();
                        renumberRows();
                    }
                }, ['×']) : null
            ].filter(Boolean));
            const group = { name: nameInput, club: clubInput, rating: ratingInput, row };
            fencerInputs.push(group);
            inputArea.appendChild(row);
        }

        function renumberRows() {
            fencerInputs.forEach((g, idx) => {
                const pos = g.row.querySelector('.td-pos');
                if (pos) pos.textContent = String(idx + 1);
            });
        }

        // Start with profile + 4 empties
        addFencerRow();
        for (let i = 0; i < 4; i++) addFencerRow();
        parent.appendChild(inputArea);

        parent.appendChild(el('div', { class: 'td-input-actions' }, [
            el('button', {
                type: 'button', class: 'btn btn-ghost btn-sm',
                onclick: () => addFencerRow()
            }, ['+ Add fencer']),
            el('button', {
                type: 'button', class: 'btn btn-primary',
                onclick: async () => {
                    const fencers = [];
                    for (const g of fencerInputs) {
                        const name = g.name.value.trim();
                        if (!name) continue;
                        fencers.push({
                            name,
                            club: g.club.value.trim() || null,
                            rating: g.rating.value.trim().toUpperCase() || null,
                            archetypes: [],
                            intel: null
                        });
                    }
                    if (fencers.length < 3) {
                        toast('Need at least 3 fencers in the pool', 'error');
                        return;
                    }
                    // Resolve intel + existing opponent IDs
                    await Promise.all(fencers.map(async (f, i) => {
                        if (i === 0) return;
                        try {
                            const intel = await getIntel(f.name);
                            if (intel) { f.intel = { headline: intel.headline, club: intel.club, rating_year: intel.strength_year?.current }; }
                        } catch {}
                    }));
                    pool = { fencers, myIndex: 0, bouts: {}, des: [] };
                    savePoolToCache(tournament.id, pool);
                    render();
                }
            }, ['Start pool →'])
        ]));
    }

    function renderPoolGrid(parent) {
        const n = pool.fencers.length;

        parent.appendChild(el('div', { class: 'td-section' }, [
            el('div', { class: 'td-section-head' }, [
                el('h2', { class: 'td-h2' }, ['Pool']),
                el('span', { class: 'td-section-meta' }, [`${n} fencers · ${myStats().bouts}/${n - 1} bouts logged`])
            ])
        ]));

        // Build the table
        const table = el('table', { class: 'td-grid' });
        const thead = el('thead');
        const headRow = el('tr', {}, [
            el('th', { class: 'td-h-corner' }, ['']),
            ...pool.fencers.map((_, i) => el('th', { class: 'td-h-col' }, [String(i + 1)])),
            el('th', { class: 'td-h-stat' }, ['V']),
            el('th', { class: 'td-h-stat' }, ['TS']),
            el('th', { class: 'td-h-stat' }, ['TR']),
            el('th', { class: 'td-h-stat' }, ['+/−'])
        ]);
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = el('tbody');
        for (let i = 0; i < n; i++) {
            const f = pool.fencers[i];
            const isMe = i === pool.myIndex;
            const tr = el('tr', { class: isMe ? 'td-row-me' : 'td-row' });
            tr.appendChild(el('th', { class: 'td-h-row' }, [
                el('span', { class: 'td-row-pos' }, [String(i + 1)]),
                el('span', { class: 'td-row-name' }, [f.name + (isMe ? ' (you)' : '')]),
                f.club ? el('span', { class: 'td-row-club' }, [f.club]) : null,
                f.rating ? el('span', { class: 'td-row-rating' }, [f.rating]) : null,
                f.intel?.headline ? el('span', { class: 'td-row-intel' }, [f.intel.headline]) : null
            ].filter(Boolean)));
            for (let j = 0; j < n; j++) {
                tr.appendChild(buildCell(i, j));
            }
            const s = rowStats(i);
            tr.appendChild(el('td', { class: 'td-stat-cell' }, [String(s.V)]));
            tr.appendChild(el('td', { class: 'td-stat-cell' }, [String(s.TS)]));
            tr.appendChild(el('td', { class: 'td-stat-cell' }, [String(s.TR)]));
            tr.appendChild(el('td', { class: 'td-stat-cell td-stat-ind' + (s.IND >= 0 ? ' pos' : ' neg') }, [(s.IND >= 0 ? '+' : '') + s.IND]));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        parent.appendChild(table);
    }

    function buildCell(i, j) {
        if (i === j) return el('td', { class: 'td-cell-diag' }, ['—']);
        const isMine = i === pool.myIndex || j === pool.myIndex;
        const key = boutKey(i, j);
        const b = pool.bouts[key];
        let label = '·';
        let cls = 'td-cell';
        if (b) {
            // Storage convention: iScore = LOWER-index fencer's score, theirScore = HIGHER's.
            // For cell (i, j), this row's perspective:
            const myScoreInRow = (i < j) ? b.iScore : b.theirScore;
            const iWonThisRow = (i < j) ? b.iWon : !b.iWon;
            label = iWonThisRow ? `V${myScoreInRow}` : `D${myScoreInRow}`;
            cls += iWonThisRow ? ' win' : ' loss';
        }
        return el('td', {
            class: cls + (isMine ? ' td-cell-mine' : ''),
            onclick: () => openScoreModal(i, j)
        }, [label]);
    }

    function openScoreModal(i, j) {
        if (i === j) return;
        const isMyRow = i === pool.myIndex || j === pool.myIndex;
        const me = pool.fencers[pool.myIndex];
        const oppIdx = i === pool.myIndex ? j : (j === pool.myIndex ? i : -1);
        const otherA = pool.fencers[i];
        const otherB = pool.fencers[j];
        const existing = pool.bouts[boutKey(i, j)];

        // Translate stored bout (min-index normalized) to current modal's (i, j) perspective.
        const existIsScore = existing ? ((i < j) ? existing.iScore : existing.theirScore) : 5;
        const existThemScore = existing ? ((i < j) ? existing.theirScore : existing.iScore) : 0;
        const existIWon = existing ? ((i < j) ? existing.iWon : !existing.iWon) : null;

        const sheet = el('div', { class: 'td-sheet-bg', onclick: (e) => { if (e.target.classList.contains('td-sheet-bg')) close(); } });
        const sheetInner = el('div', { class: 'td-sheet' });
        const myScore = el('input', { type: 'number', class: 'td-score-input', value: existIsScore, min: 0, max: 5 });
        const themScore = el('input', { type: 'number', class: 'td-score-input', value: existThemScore, min: 0, max: 5 });
        const iWon = { val: existIWon };

        function updateResultUI() {
            const a = Number(myScore.value) || 0, b = Number(themScore.value) || 0;
            if (a > b) iWon.val = true;
            else if (b > a) iWon.val = false;
            else iWon.val = null;
            const line = sheetInner.querySelector('.td-sheet-result');
            if (!line) return;
            if (iWon.val === true) {
                const winner = (i === pool.myIndex ? me.name : otherA.name);
                line.textContent = `${winner.toUpperCase()} wins ${a}-${b}`;
                line.style.color = '#1f7a1f';
            } else if (iWon.val === false) {
                const winner = (j === pool.myIndex ? me.name : otherB.name);
                line.textContent = `${winner.toUpperCase()} wins ${b}-${a}`;
                line.style.color = '#1f7a1f';
            } else {
                line.textContent = 'Tied — increment the winner (priority touch).';
                line.style.color = '#9b2230';
            }
        }
        myScore.addEventListener('input', updateResultUI);
        themScore.addEventListener('input', updateResultUI);

        sheetInner.appendChild(el('div', { class: 'td-sheet-head' }, [
            el('span', { class: 'td-sheet-eye' }, [isMyRow ? 'YOUR BOUT' : 'POOL BOUT']),
            el('button', { type: 'button', class: 'td-sheet-x', onclick: close }, ['×'])
        ]));
        sheetInner.appendChild(el('div', { class: 'td-sheet-pair' }, [
            el('div', { class: 'td-sheet-fencer' }, [
                el('div', { class: 'td-sheet-fencer-name' }, [(i === pool.myIndex ? me.name + ' (you)' : otherA.name)]),
                el('div', { class: 'td-sheet-fencer-meta' }, [(i === pool.myIndex ? '' : otherA.club || '') + (otherA.rating ? ' · ' + otherA.rating : '')]),
                myScore
            ]),
            el('div', { class: 'td-sheet-vs' }, ['VS']),
            el('div', { class: 'td-sheet-fencer' }, [
                el('div', { class: 'td-sheet-fencer-name' }, [(j === pool.myIndex ? me.name + ' (you)' : otherB.name)]),
                el('div', { class: 'td-sheet-fencer-meta' }, [(j === pool.myIndex ? '' : otherB.club || '') + (otherB.rating ? ' · ' + otherB.rating : '')]),
                themScore
            ])
        ]));
        // Auto-determined result line (replaces the V/D toggle buttons).
        sheetInner.appendChild(el('div', { class: 'td-sheet-result', style: 'text-align:center;font-family:var(--eg-mono,monospace);font-size:13px;font-weight:700;letter-spacing:0.06em;padding:8px 0 4px;color:#6B7280;' }, ['']));
        sheetInner.appendChild(el('div', { class: 'td-sheet-actions' }, [
            existing ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { delete pool.bouts[boutKey(i,j)]; savePoolToCache(tournament.id, pool); close(); render(); } }, ['Delete']) : null,
            el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
                const a = Number(myScore.value) || 0, b = Number(themScore.value) || 0;
                if (a === b) { toast('Tied score — increment the winner (priority touch)', 'error'); return; }
                iWon.val = (a > b);
                // Normalize on save so iScore is always for the LOWER-index fencer.
                const bout = (i < j)
                    ? { iScore: a, theirScore: b, iWon: iWon.val }
                    : { iScore: b, theirScore: a, iWon: !iWon.val };
                pool.bouts[boutKey(i, j)] = bout;
                savePoolToCache(tournament.id, pool);
                // If this is MY bout, save to bouts table
                if (i === pool.myIndex || j === pool.myIndex) {
                    const oppF = pool.fencers[i === pool.myIndex ? j : i];
                    const myScoreFor = i === pool.myIndex ? a : b;
                    const oppScoreFor = i === pool.myIndex ? b : a;
                    const won = (i === pool.myIndex) ? iWon.val : !iWon.val;
                    try {
                        await saveBout({
                            tournament, profile, oppF,
                            myScore: myScoreFor, oppScore: oppScoreFor,
                            won,
                            poolNum: 1,
                            poolPos: i === pool.myIndex ? j + 1 : i + 1
                        });
                        toast(`Saved: ${won ? 'V' : 'D'} ${myScoreFor}-${oppScoreFor} vs ${oppF.name}`);
                    } catch (e) {
                        console.warn('saveBout fail', e);
                        toast('Saved locally — will sync', 'info');
                    }
                }
                close();
                render();
            } }, ['Save bout'])
        ].filter(Boolean)));

        sheet.appendChild(sheetInner);
        document.body.appendChild(sheet);
        updateResultUI();
        function close() { sheet.remove(); }
    }

    function renderDESection(parent) {
        if (pool.fencers.length === 0) return;
        parent.appendChild(el('div', { class: 'td-section', style: { marginTop: '24px' } }, [
            el('div', { class: 'td-section-head', style: { flexWrap: 'wrap', gap: '8px' } }, [
                el('h2', { class: 'td-h2' }, ['Direct Elimination']),
                el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
                    el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: openPasteModal }, ['📋 Paste tableau']),
                    el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: addDE }, ['+ Add DE bout'])
                ])
            ])
        ]));
        if (!pool.des || !pool.des.length) {
            parent.appendChild(el('p', { class: 'td-help' }, ['No DE bouts yet. Tap 📋 Paste tableau to auto-extract from FTL, or + Add DE bout to enter manually.']));
            return;
        }
        // Sort: completed first, then pending, then predicted (in round order within each)
        const sortedDes = [...pool.des].sort((a, b) => {
            const order = { completed: 0, pending: 1, predicted: 2 };
            const sa = order[a.status || 'completed'] ?? 0;
            const sb = order[b.status || 'completed'] ?? 0;
            if (sa !== sb) return sa - sb;
            return (b.round || 0) - (a.round || 0);  // higher round (T64 > T32) first within group
        });
        for (const de of sortedDes) {
            const status = de.status || 'completed';
            const score = (de.myScore != null && de.theirScore != null)
                ? `${de.myScore}-${de.theirScore}`
                : (status === 'pending' ? '—' : '→');
            const resultLabel =
                status === 'completed' ? (de.won ? 'VICTORY' : 'DEFEAT') :
                status === 'pending' ? 'NEXT BOUT' : 'IF YOU WIN';
            const cls = 'td-de-card td-de-' + status + (status === 'completed' ? (de.won ? ' win' : ' loss') : '');
            const deRef = de;  // capture for closure
            const card = el('div', { class: cls }, [
                el('div', { class: 'td-de-head' }, [
                    el('div', { class: 'td-de-round' }, [`Round of ${de.round}`]),
                    el('button', {
                        type: 'button',
                        class: 'td-de-del',
                        title: 'Remove this DE bout',
                        onclick: () => {
                            if (!confirm(`Remove "Round of ${deRef.round} vs ${deRef.oppName}"?\n\nThis only removes the local card. Already-saved bouts in BOUTS aren't touched.`)) return;
                            pool.des = pool.des.filter(x => !(x.round === deRef.round && (x.oppName || '') === (deRef.oppName || '')));
                            savePoolToCache(tournament.id, pool);
                            toast('DE bout removed');
                            render();
                        }
                    }, ['×'])
                ]),
                el('div', { class: 'td-de-pair' }, [
                    el('strong', {}, [profile.name]),
                    el('span', { class: 'td-de-score' }, [score]),
                    el('strong', {}, [de.oppName])
                ]),
                el('div', { class: 'td-de-result' + (status === 'completed' ? (de.won ? ' win' : ' loss') : ' upcoming') }, [resultLabel]),
                de.oppClub ? el('div', { class: 'td-de-meta' }, [de.oppClub + (de.oppRating ? ' · ' + de.oppRating : '')]) : null
            ].filter(Boolean));
            parent.appendChild(card);
        }
    }

    // Get-Live-Data — pulls competitor roster from FTL via the Cloudflare Worker.
    // All string comparisons here are case-INSENSITIVE per CLAUDE.md rule #7.
    async function getLiveData() {
        const tName = (tournament.name || '').toLowerCase();
        toast('🔴 Pulling live data from FTL…', 'info');
        try {
            // Step 1: health check
            const h = await fetch(`${FTL_WORKER_URL}/health`).then(r => r.json());
            if (!h.logged_in) {
                toast('FTL session expired — refresh cookies via Cookie-Editor + wrangler secret put', 'error');
                return;
            }
            // Step 2: find tournament (case-insensitive name match).
            // Multiple years often share a name; prefer the one CLOSEST to the
            // local tournament's start_date.
            const tourResp = await fetch(`${FTL_WORKER_URL}/tournaments?period=last30`).then(r => r.json());
            let matches = (tourResp.tournaments || []).filter(t =>
                (t.name || '').toLowerCase().includes(tName) ||
                tName.includes((t.name || '').toLowerCase())
            );
            if (!matches.length) {
                toast(`No FTL tournament matches "${tournament.name}". Check tournament name.`, 'error');
                return;
            }
            // Sort by distance to local tournament's start_date (ascending — closest first)
            const localStart = tournament.start_date ? Date.parse(tournament.start_date) : Date.now();
            matches = matches.map(t => ({
                t,
                diff: Math.abs((Date.parse(t.start || t.dates) || 0) - localStart)
            })).sort((a, b) => a.diff - b.diff).map(x => x.t);
            const ftlTour = matches[0];
            console.log('[getLiveData] picked tournament:', ftlTour.name, 'start:', ftlTour.start, 'from', matches.length, 'matches');
            // Step 3: find event for this profile's role (case-insensitive)
            const evResp = await fetch(`${FTL_WORKER_URL}/events?tid=${ftlTour.id}`).then(r => r.json());
            const events = evResp.events || [];
            // Match Cadet MF for Raedyn, Y12 MF for Kaylan, Y14 MF as fallback
            const eventKeyPrefs = (profile.role === 'kaylan' || Number(profile.birth_year) >= 2014)
                ? ['y-12 men', 'y12 men', 'youth 12 men']
                : ['cadet men', 'y-14 men', 'y14 men', 'youth 14 men'];
            let event = null;
            for (const pref of eventKeyPrefs) {
                event = events.find(e => (e.name || '').toLowerCase().includes(pref) && (e.name || '').toLowerCase().includes('foil'));
                if (event) break;
            }
            if (!event) {
                toast(`No matching event for ${profile.name} in ${ftlTour.name}`, 'error');
                console.log('Events found:', events.map(e => e.name));
                return;
            }
            // Step 4: pull competitor list, locate the user
            const cResp = await fetch(`${FTL_WORKER_URL}/event/competitors?eid=${event.id}`).then(r => r.json());
            const comps = cResp.competitors || [];
            const myTokens = normalizeName(profile.name).split(' ').filter(t => t.length >= 3);
            const me = comps.find(c => {
                const n = (c.name || '').toLowerCase();
                return myTokens.some(t => n.includes(t));
            });
            if (!me) {
                toast(`${profile.name} not in roster for ${event.name}`, 'error');
                return;
            }
            // FTL JSON shape: name, club1, weaponRating (e.g. "B26"), rankSort (high=no rank).
            const myRating = me.weaponRating || me.rating || '';
            const myRank = (me.rankSort && me.rankSort < 9000) ? `#${me.rankSort}` : '-';
            toast(`✓ ${ftlTour.name} → ${event.name} → ${profile.name} (${myRating || myRank}) in ${comps.length}-fencer roster`, 'info');
            pool.live = {
                tournamentName: ftlTour.name,
                eventName: event.name,
                eventId: event.id,
                rosterSize: comps.length,
                me: { name: me.name, club: me.club1, rating: myRating, rank: myRank, div: me.div || '' },
                fetched_at: Date.now()
            };
            // Try pool + tableau in parallel. These Worker endpoints may not
            // exist yet — fail soft if so (catch→null) and just keep roster.
            try {
                const [pr, tr] = await Promise.all([
                    fetch(`${FTL_WORKER_URL}/event/pools?eid=${event.id}`).then(r => r.json()).catch(() => null),
                    fetch(`${FTL_WORKER_URL}/event/tableau?eid=${event.id}&user=${encodeURIComponent(profile.name)}`).then(r => r.json()).catch(() => null)
                ]);
                if (pr && pr.ok && pr.data) { pool.live.poolsRaw = pr.data; pool.live.poolsPath = pr.path; }
                if (tr && tr.ok && (tr.seeding?.length || tr.trees?.length)) {
                    pool.live.tableauRaw = { seeding: tr.seeding || [], trees: tr.trees || [], de_bouts: tr.de_bouts || null };
                }
            } catch (e) {
                console.warn('pool/tableau fetch failed (worker may not have endpoints yet)', e);
            }
            savePoolToCache(tournament.id, pool);
            render();
        } catch (e) {
            console.warn('getLiveData fail', e);
            toast('Live-data fetch failed: ' + (e.message || e), 'error');
        }
    }

    function addDE() {
        const sheet = el('div', { class: 'td-sheet-bg', onclick: (e) => { if (e.target.classList.contains('td-sheet-bg')) close(); } });
        const sheetInner = el('div', { class: 'td-sheet' });

        const roundSelect = el('select', { class: 'td-input' }, [
            ['64', 'Table of 64'],
            ['32', 'Table of 32'],
            ['16', 'Table of 16'],
            ['8', 'Table of 8 (Quarterfinal)'],
            ['4', 'Semifinal'],
            ['2', 'Final']
        ].map(([v, label]) => el('option', { value: v, selected: v === '32' }, [label])));

        const oppNameInput = el('input', { type: 'text', class: 'td-input', placeholder: 'Opponent name (e.g. ZHOU jiatong)' });
        const oppClubInput = el('input', { type: 'text', class: 'td-input', placeholder: 'Opponent club (optional)' });
        const myScoreInput = el('input', { type: 'number', class: 'td-score-input', value: 15, min: 0, max: 15 });
        const themScoreInput = el('input', { type: 'number', class: 'td-score-input', value: 12, min: 0, max: 15 });
        const wonRef = { val: true };

        function updateVD() {
            const my = Number(myScoreInput.value) || 0;
            const them = Number(themScoreInput.value) || 0;
            if (my > them) wonRef.val = true;
            else if (them > my) wonRef.val = false;
            else wonRef.val = null;
            const line = sheetInner.querySelector('.td-sheet-result');
            if (!line) return;
            if (wonRef.val === true) {
                line.textContent = `${profile.name.toUpperCase()} wins ${my}-${them}`;
                line.style.color = '#1f7a1f';
            } else if (wonRef.val === false) {
                line.textContent = `OPPONENT wins ${them}-${my}`;
                line.style.color = '#1f7a1f';
            } else {
                line.textContent = 'Tied — increment the winner (priority touch).';
                line.style.color = '#9b2230';
            }
        }
        // Hook inputs so the result line updates as you type
        // (declared after both inputs exist — moved listener attach below in the build flow.)

        sheetInner.appendChild(el('div', { class: 'td-sheet-head' }, [
            el('span', { class: 'td-sheet-eye' }, ['+ ADD DE BOUT']),
            el('button', { type: 'button', class: 'td-sheet-x', onclick: close }, ['×'])
        ]));

        sheetInner.appendChild(el('div', { class: 'field', style: { marginTop: '8px' } }, [
            el('label', { class: 'field-label' }, ['Round']),
            roundSelect
        ]));
        sheetInner.appendChild(el('div', { class: 'field' }, [
            el('label', { class: 'field-label' }, ['Opponent name']),
            oppNameInput
        ]));
        sheetInner.appendChild(el('div', { class: 'field' }, [
            el('label', { class: 'field-label' }, ['Opponent club']),
            oppClubInput
        ]));
        sheetInner.appendChild(el('div', { class: 'td-sheet-pair' }, [
            el('div', { class: 'td-sheet-fencer' }, [
                el('div', { class: 'td-sheet-fencer-name' }, [profile.name + ' (you)']),
                myScoreInput
            ]),
            el('div', { class: 'td-sheet-vs' }, ['VS']),
            el('div', { class: 'td-sheet-fencer' }, [
                el('div', { class: 'td-sheet-fencer-name' }, ['Opponent']),
                themScoreInput
            ])
        ]));
        // Auto-result line (replaces V/D toggle buttons in DE bout entry).
        sheetInner.appendChild(el('div', { class: 'td-sheet-result', style: 'text-align:center;font-family:var(--eg-mono,monospace);font-size:13px;font-weight:700;letter-spacing:0.06em;padding:8px 0 4px;color:#6B7280;' }, ['']));
        myScoreInput.addEventListener('input', updateVD);
        themScoreInput.addEventListener('input', updateVD);
        updateVD();
        sheetInner.appendChild(el('div', { class: 'td-sheet-actions' }, [
            el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, ['Cancel']),
            el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
                const oppName = (oppNameInput.value || '').trim();
                if (!oppName) { toast('Opponent name required', 'error'); return; }
                const round = Number(roundSelect.value);
                const my = Number(myScoreInput.value) || 0;
                const them = Number(themScoreInput.value) || 0;
                if (my === them) { toast('Tied score — increment the winner (priority touch)', 'error'); return; }
                wonRef.val = (my > them);
                pool.des = pool.des || [];
                pool.des.push({
                    round,
                    oppName,
                    oppClub: (oppClubInput.value || '').trim() || null,
                    myScore: my,
                    theirScore: them,
                    won: wonRef.val
                });
                savePoolToCache(tournament.id, pool);
                try {
                    await saveBout({
                        tournament, profile,
                        oppF: { name: oppName, club: oppClubInput.value.trim() || null, rating: null },
                        myScore: my, oppScore: them, won: wonRef.val,
                        deRound: round
                    });
                    toast(`DE saved · T${round}`);
                } catch (e) {
                    console.warn(e);
                    toast('Saved locally', 'info');
                }
                close();
                render();
            } }, ['Save DE bout'])
        ]));
        sheet.appendChild(sheetInner);
        document.body.appendChild(sheet);
        setTimeout(() => oppNameInput.focus(), 50);
        function close() { sheet.remove(); }
    }

    // === Helpers ===========================================================
    function newPool() { return { fencers: [], myIndex: 0, bouts: {}, des: [] }; }
    function boutKey(i, j) { return i < j ? `${i}-${j}` : `${j}-${i}`; }

    function rowStats(i) {
        let V = 0, TS = 0, TR = 0;
        for (let j = 0; j < pool.fencers.length; j++) {
            if (i === j) continue;
            const b = pool.bouts[boutKey(i, j)];
            if (!b) continue;
            const myScoreInThisCell = (i < j) ? b.iScore : b.theirScore;
            const themScoreInThisCell = (i < j) ? b.theirScore : b.iScore;
            const iWonThisRow = (i < j) ? b.iWon : !b.iWon;
            if (iWonThisRow) V++;
            TS += myScoreInThisCell;
            TR += themScoreInThisCell;
        }
        return { V, TS, TR, IND: TS - TR };
    }
    function myStats() {
        const me = rowStats(pool.myIndex);
        const n = pool.fencers.length;
        let bouts = 0;
        for (let j = 0; j < n; j++) if (j !== pool.myIndex && pool.bouts[boutKey(pool.myIndex, j)]) bouts++;
        return { ...me, bouts };
    }

    function openPasteModal() {
        const sheet = el('div', { class: 'td-sheet-bg', onclick: (e) => { if (e.target.classList.contains('td-sheet-bg')) close(); } });
        const sheetInner = el('div', { class: 'td-sheet td-paste-sheet' });
        const textarea = el('textarea', {
            class: 'td-paste-textarea',
            rows: 12,
            placeholder: 'Paste here…\n\n• On iPhone Safari: long-press the FTL pool details page → Select All → Copy → tap into this box → Paste.\n• Works whether you paste 1 pool or all 10 — I\'ll auto-detect which pool you\'re in.\n• Don\'t worry about scores, referees, Bout Order — the parser strips them.',
            autofocus: true
        });
        const previewArea = el('div', { class: 'td-paste-preview' });
        let selectedPoolIdx = 0;
        let userPickedPool = false;  // becomes true once user manually taps a pool card
        let lastParsed = null;

        // Case-insensitive: find which pool contains the active fencer by lastname token
        function findUserPoolIdx(pools) {
            if (!pools || !pools.length) return -1;
            const me = normalizeName(profile.name);
            const meTokens = me.split(' ').filter(Boolean);
            if (!meTokens.length) return -1;
            for (let i = 0; i < pools.length; i++) {
                for (const f of pools[i].fencers) {
                    const fNorm = normalizeName(f.name);
                    if (meTokens.some(t => t.length >= 3 && fNorm.includes(t))) return i;
                }
            }
            return -1;
        }

        function refreshPreview() {
            // First: try DE-tableau detection
            const deParsed = parseFtlDETableau(textarea.value, profile.name);
            if (deParsed && deParsed.isDETableau) {
                lastParsed = { ...deParsed, mode: 'de' };
                previewArea.innerHTML = '';
                if (!deParsed.userFound) {
                    previewArea.appendChild(el('p', { class: 'td-paste-empty' }, [
                        `DE tableau detected, but ${profile.name} not found in it. Paste the right event's tableau.`
                    ]));
                    return;
                }
                if (!deParsed.bouts.length) {
                    previewArea.appendChild(el('p', { class: 'td-paste-empty' }, [
                        `Found ${profile.name}, but couldn't extract bout scores. Check if the tableau shows results.`
                    ]));
                    return;
                }
                const nDone = deParsed.bouts.filter(b => b.status === 'completed').length;
                const nPend = deParsed.bouts.filter(b => b.status === 'pending').length;
                const nPred = deParsed.bouts.filter(b => b.status === 'predicted').length;
                const summary = [
                    `Direct Elimination — ${profile.name}'s bracket path:`,
                    nDone ? `${nDone} completed` : null,
                    nPend ? `${nPend} pending` : null,
                    nPred ? `${nPred} predicted (if you win)` : null
                ].filter(Boolean).join('  ·  ');
                previewArea.appendChild(el('div', { class: 'td-paste-count' }, [summary]));
                for (const b of deParsed.bouts) {
                    const statusCls =
                        b.status === 'completed' ? (b.won ? ' win' : ' loss') :
                        b.status === 'pending' ? ' pending' :
                        ' predicted';
                    const statusLabel =
                        b.status === 'completed' ? (b.won ? 'VICTORY' : 'DEFEAT') :
                        b.status === 'pending' ? 'NEXT BOUT' :
                        'IF YOU WIN';
                    const scoreText = (b.status === 'completed' && b.my_score != null)
                        ? `${b.my_score}-${b.opp_score}`
                        : (b.status === 'pending' ? '—' : '→');
                    previewArea.appendChild(el('div', { class: 'td-paste-de-row' + statusCls }, [
                        el('span', { class: 'td-paste-de-round' }, [`T${b.round}`]),
                        el('div', { class: 'td-paste-de-mid' }, [
                            el('span', { class: 'td-paste-de-opp' }, [
                                b.opponent_seed
                                    ? `vs (${b.opponent_seed}) ${b.opponent_name}`
                                    : `vs ${b.opponent_name}`
                            ]),
                            b.opponent_club ? el('span', { class: 'td-paste-de-club' }, [b.opponent_club]) : null
                        ].filter(Boolean)),
                        el('span', { class: 'td-paste-de-score' }, [scoreText]),
                        el('span', { class: 'td-paste-de-result' }, [statusLabel])
                    ]));
                }
                return;
            }
            // Otherwise: pool parse
            const parsed = parseFtlText(textarea.value);
            lastParsed = { ...parsed, mode: 'pool' };
            previewArea.innerHTML = '';

            // Multi-pool: render pool cards as picker
            if (parsed.pools && parsed.pools.length > 1) {
                // Auto-select the user's pool — unless the user already picked one
                const autoIdx = findUserPoolIdx(parsed.pools);
                if (!userPickedPool && autoIdx >= 0) selectedPoolIdx = autoIdx;

                const headBits = [`Detected ${parsed.pools.length} pools.`];
                if (autoIdx >= 0) headBits.push(`✓ Found ${profile.name} in Pool #${parsed.pools[autoIdx].number} — pre-selected.`);
                else headBits.push("Couldn't find your name — tap the right pool below.");
                previewArea.appendChild(el('div', { class: 'td-paste-count' }, [headBits.join(' ')]));

                for (let i = 0; i < parsed.pools.length; i++) {
                    const p = parsed.pools[i];
                    const card = el('button', {
                        type: 'button',
                        class: 'td-paste-pool-card' + (i === selectedPoolIdx ? ' selected' : '') + (i === autoIdx ? ' auto' : ''),
                        onclick: () => { selectedPoolIdx = i; userPickedPool = true; refreshPreview(); }
                    }, [
                        el('div', { class: 'td-paste-pool-head' }, [
                            el('span', { class: 'td-paste-pool-num' }, [`POOL #${p.number}`]),
                            p.strip ? el('span', { class: 'td-paste-pool-strip' }, [`Strip ${p.strip}`]) : null,
                            i === autoIdx ? el('span', { class: 'td-paste-pool-auto' }, ['★ YOU']) : null,
                            el('span', { class: 'td-paste-pool-count' }, [`${p.fencers.length} fencers`])
                        ].filter(Boolean)),
                        el('div', { class: 'td-paste-pool-roster' }, p.fencers.slice(0, 4).map(f =>
                            el('span', { class: 'td-paste-pool-name' }, [f.name])
                        ).concat(p.fencers.length > 4 ? [el('span', { class: 'td-paste-pool-more' }, [`+${p.fencers.length - 4} more`])] : []))
                    ]);
                    previewArea.appendChild(card);
                }
                return;
            }

            // Single pool OR flat fencer list
            const fencers = (parsed.pools && parsed.pools[0]) ? parsed.pools[0].fencers : parsed.fencers;
            if (!fencers || !fencers.length) {
                previewArea.appendChild(el('p', { class: 'td-paste-empty' }, ['No fencers detected yet. Paste pool text above.']));
                return;
            }
            previewArea.appendChild(el('div', { class: 'td-paste-count' }, [
                parsed.pools && parsed.pools[0]
                    ? `Pool #${parsed.pools[0].number} — ${fencers.length} fencers:`
                    : `Detected ${fencers.length} fencer${fencers.length === 1 ? '' : 's'}:`
            ]));
            for (const f of fencers.slice(0, 12)) {
                previewArea.appendChild(el('div', { class: 'td-paste-row' }, [
                    el('span', { class: 'td-paste-name' }, [f.name]),
                    f.club ? el('span', { class: 'td-paste-club' }, [f.club]) : null,
                    f.rating ? el('span', { class: 'td-paste-rating' }, [f.rating]) : null
                ].filter(Boolean)));
            }
            if (fencers.length > 12) {
                previewArea.appendChild(el('p', { class: 'td-paste-more' }, [`+ ${fencers.length - 12} more`]));
            }
        }

        function loadPool(fencers) {
            if (!fencers || fencers.length < 3) {
                toast('Need at least 3 fencers — try copying more of the page', 'error');
                return false;
            }
            // Inject "me" at top if not there — case-INSENSITIVE matching per CLAUDE.md #7
            const meNorm = normalizeName(profile.name);
            const meLastTokens = meNorm.split(' ').filter(Boolean);
            const meLastName = meLastTokens[meLastTokens.length - 1] || meLastTokens[0] || '';
            const meFirstName = meLastTokens[0] || '';
            const fencersOut = fencers.map(f => ({
                name: f.name,
                club: f.club,
                rating: f.rating || null,
                archetypes: [],
                intel: null
            }));
            const meAt = fencersOut.findIndex(f => {
                const fNorm = normalizeName(f.name);
                // Match if any token of the user's name appears in the candidate's normalized form
                return (meLastName && fNorm.includes(meLastName)) ||
                       (meFirstName && fNorm.includes(meFirstName));
            });
            if (meAt > 0) {
                const me = fencersOut.splice(meAt, 1)[0];
                fencersOut.unshift(me);
            } else if (meAt < 0) {
                fencersOut.unshift({ name: profile.name, club: null, rating: null, archetypes: [], intel: null });
            }
            pool = { fencers: fencersOut, myIndex: 0, bouts: {}, des: [] };
            savePoolToCache(tournament.id, pool);
            toast(`Loaded ${fencersOut.length} fencers — pool ready`);
            return true;
        }

        textarea.addEventListener('input', refreshPreview);

        sheetInner.appendChild(el('div', { class: 'td-sheet-head' }, [
            el('span', { class: 'td-sheet-eye' }, ['📋 PASTE FROM FTL']),
            el('button', { type: 'button', class: 'td-sheet-x', onclick: close }, ['×'])
        ]));
        sheetInner.appendChild(textarea);
        sheetInner.appendChild(previewArea);
        sheetInner.appendChild(el('div', { class: 'td-sheet-actions' }, [
            el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, ['Cancel']),
            el('button', { type: 'button', class: 'btn btn-primary', onclick: () => {
                if (!lastParsed) return;
                // DE-tableau mode
                if (lastParsed.mode === 'de' && Array.isArray(lastParsed.bouts) && lastParsed.bouts.length) {
                    pool.des = pool.des || [];
                    let savedCount = 0, pendingCount = 0;
                    for (const b of lastParsed.bouts) {
                        // De-dupe by opponent + round (keep latest status)
                        const existing = pool.des.findIndex(x =>
                            x.round === b.round &&
                            normalizeName(x.oppName || '') === normalizeName(b.opponent_name || '')
                        );
                        const entry = {
                            round: b.round,
                            oppName: b.opponent_name,
                            oppClub: b.opponent_club || null,
                            oppRating: b.opponent_seed ? `seed ${b.opponent_seed}` : null,
                            myScore: b.my_score,
                            theirScore: b.opp_score,
                            won: b.won,
                            status: b.status || 'completed'
                        };
                        if (existing >= 0) pool.des[existing] = entry;
                        else pool.des.push(entry);
                        // Save to Supabase ONLY if completed (don't save predicted/pending)
                        if (b.status === 'completed' && b.my_score != null) {
                            saveBout({
                                tournament, profile,
                                oppF: { name: b.opponent_name, club: b.opponent_club || null, rating: null },
                                myScore: b.my_score, oppScore: b.opp_score, won: b.won,
                                deRound: b.round
                            }).catch((e) => console.warn('DE save fail', e));
                            savedCount++;
                        } else {
                            pendingCount++;
                        }
                    }
                    savePoolToCache(tournament.id, pool);
                    const msg = `Loaded ${savedCount} completed${pendingCount ? `, ${pendingCount} upcoming` : ''}`;
                    toast(msg);
                    close();
                    render();
                    return;
                }
                // Pool mode
                let fencers;
                if (lastParsed.pools && lastParsed.pools.length > 1) {
                    fencers = lastParsed.pools[selectedPoolIdx]?.fencers || [];
                } else if (lastParsed.pools && lastParsed.pools.length === 1) {
                    fencers = lastParsed.pools[0].fencers;
                } else {
                    fencers = lastParsed.fencers || [];
                }
                if (loadPool(fencers)) { close(); render(); }
            } }, ['Load →'])
        ]));
        sheet.appendChild(sheetInner);
        document.body.appendChild(sheet);
        setTimeout(() => textarea.focus(), 50);
        refreshPreview();
        function close() { sheet.remove(); }
    }
}

// === Persistence (per-tournament localStorage cache) ======================
function poolCacheKey(tid) { return `eg-td-pool-${tid}`; }
function loadPoolFromCache(tid) {
    try { const raw = localStorage.getItem(poolCacheKey(tid)); if (raw) return JSON.parse(raw); }
    catch {}
    return null;
}
function savePoolToCache(tid, pool) {
    try { localStorage.setItem(poolCacheKey(tid), JSON.stringify(pool)); } catch {}
}

// === Save a bout into Supabase ============================================
async function saveBout({ tournament, profile, oppF, myScore, oppScore, won, poolNum, poolPos, deRound }) {
    // Find or create opponent record
    const opp = await findOrCreateOpponent({
        name: oppF.name,
        club: oppF.club || null,
        rating: oppF.rating || null
    });
    const notesMeta = JSON.stringify({
        tournament_id: tournament.id,
        tournament_name: tournament.name,
        ...(poolNum ? { pool_num: poolNum, pool_pos: poolPos } : {}),
        ...(deRound ? { de_round: deRound } : {})
    });
    // Column names must match the bouts table. score_for/score_against/round/
    // notes were invented here and do not exist, so every bout logged from
    // tournament day was rejected outright - the same class of failure as
    // tactics_used on the main form.
    const payload = {
        profile_id: profile.id,
        opponent_id: opp.id,
        date: todayISO(),
        outcome: won ? 'win' : 'loss',
        my_score: myScore,
        their_score: oppScore,
        // 'round' has no column; context already carries where a bout happened.
        context: poolNum ? 'pool' : 'de',
        reflection: '__TD__' + notesMeta
    };
    await safeWrite({ table: 'bouts', op: 'insert', payload });
}
