// Lost bouts from the results. FencingTracker already knows every bout a boy
// fenced at a competition: the opponent, the score, the round, the day. The
// journal should not make a twelve-year-old retype any of that. This module
// finds the losses in the last four months that are not in the journal yet,
// prefills the facts for the entry form, links what was logged by hand to the
// result row it came from, and keeps the opponent record growing so the next
// time he draws the same fencer the history is already there.

import { el } from './util.js';
import { supa } from './supa.js';
import { go } from './router.js';

const DAYS = 120;
const INK = 'var(--ink)';
// Literal: var(--ink-mute) composites below AA on the cream surface.
const INK_MUTE = '#6B7280';
const BAD = '#9b2230';
const GOOD = '#1f7a1f';
const WARN = '#B45309';

const CAT = { y10: 'Y10', y12: 'Y12', y14: 'Y14', cadet: 'Cadet', junior: 'Junior', div1: 'Div I', div2: 'Div II', div3: 'Div III', senior: 'Senior' };
export const catLabel = (c) => CAT[String(c || '').toLowerCase()] || (c ? String(c).toUpperCase() : '');
// Pools are fenced to 5; anything past that is a direct-elimination bout.
export const stageOf = (f) => Math.max(f.score_for || 0, f.score_against || 0) > 5 ? 'de' : 'pool';
const stageLabel = (s) => s === 'de' ? 'DE' : 'Pool';
const fmt = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Case-insensitive, punctuation-blind name tokens. "GUDIMETLA Siddhanth",
// "Gudimetla, Siddhanth" and a typed "Gutimetla" all have to find each other.
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}
export function nameClose(logged, tracker) {
    const a = tokens(logged); if (!a.length) return true;   // quick-logged: score only, name later
    const b = tokens(tracker); if (!b.length) return false;
    return a.some((x) => b.some((y) => x === y || (x.length >= 4 && y.length >= 4 && lev(x, y) <= 2)));
}

// Club, rating and strength for a set of tracker ids, from whichever
// snapshot we already hold. Nothing is fetched here.
export async function snapshotsFor(tids) {
    const ids = [...new Set((tids || []).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    const [fs, ps, op] = await Promise.all([
        supa.from('fencer_snapshot').select('tracker_id,name,club,rating,strength_de,strength_pool,de_90d').in('tracker_id', ids),
        supa.from('peer_snapshot').select('tracker_id,name,club,rating,strength_de,strength_pool').in('tracker_id', ids),
        supa.from('opponent_profiles').select('tracker_id,name,club,rating,strength_de,strength_pool').in('tracker_id', ids)
    ]);
    for (const src of [fs.data, ps.data, op.data]) {
        for (const r of src || []) {
            const cur = out.get(r.tracker_id) || {};
            out.set(r.tracker_id, {
                tracker_id: r.tracker_id,
                name: cur.name || r.name || null,
                club: cur.club || r.club || null,
                rating: cur.rating || r.rating || null,
                strength_de: cur.strength_de || r.de_90d || r.strength_de || null,
                strength_pool: cur.strength_pool || r.strength_pool || null
            });
        }
    }
    return out;
}

// One fencer's profile read on demand (club, rating, strength), cached three
// days server-side by refresh-peer. Used only when nothing we hold knows him.
async function fetchPeer(tid) {
    try {
        const { data, error } = await supa.functions.invoke('refresh-peer', { body: { tracker_id: tid } });
        if (error || !data || data.error) return null;
        return { tracker_id: tid, name: data.name || null, club: data.club || null, rating: data.rating || null, strength_de: data.strength_de || null, strength_pool: data.strength_pool || null };
    } catch (e) { console.warn('peer read failed', e); return null; }
}
export async function factsFor(tid) {
    if (!tid) return {};
    const m = await snapshotsFor([tid]);
    return m.get(tid) || (await fetchPeer(tid)) || {};
}

// Everyone the boy has fenced at a competition in the last year, from the
// results: the names the form suggests, and the ids behind them.
export async function recentResultOpponents(profile) {
    const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const { data } = await supa.from('fencer_bouts').select('opponent,opponent_tracker_id,bout_date').eq('profile_id', profile.id).gte('bout_date', since).order('bout_date', { ascending: false });
    const seen = new Map();
    for (const r of data || []) if (r.opponent && !seen.has(r.opponent.toLowerCase())) seen.set(r.opponent.toLowerCase(), { name: r.opponent, tracker_id: r.opponent_tracker_id, last: r.bout_date });
    return [...seen.values()];
}
// A typed name must carry the surname (the first token of the tracker's
// "LAST First"), within two letters, and resolve to exactly one fencer.
function surnameClose(typed, tracker) {
    const a = tokens(typed), b = tokens(tracker);
    if (!a.length || !b.length) return false;
    const sur = b[0];
    return a.some((x) => x === sur || (x.length >= 4 && sur.length >= 4 && lev(x, sur) <= 2));
}
export function matchResultOpponent(list, name) {
    const t = tokens(name); if (!t.length) return null;
    const exact = list.filter((o) => { const b = tokens(o.name); return t.every((x) => b.includes(x)); });
    const pool = exact.length ? exact : list.filter((o) => surnameClose(name, o.name));
    const ids = [...new Set(pool.map((o) => o.tracker_id).filter(Boolean))];
    return ids.length === 1 ? pool.find((o) => o.tracker_id === ids[0]) : null;
}
// What the results know about a typed name: the tracker id, rating, club.
export async function factsForName(profile, name, list) {
    const hit = matchResultOpponent(list || await recentResultOpponents(profile), name);
    if (!hit?.tracker_id) return null;
    const f = await factsFor(hit.tracker_id);
    return { tracker_id: hit.tracker_id, name: hit.name, rating: f.rating || null, club: f.club || null, strength_de: f.strength_de || null };
}
// An opponent record without a tracker id, or without club or rating, gets
// them from the results. Only empty fields are filled.
export async function autoFillOpponent(profile, opp) {
    const patch = {};
    let tid = opp.tracker_id;
    if (!tid) {
        const hit = matchResultOpponent(await recentResultOpponents(profile), opp.name);
        if (hit?.tracker_id) { tid = hit.tracker_id; patch.tracker_id = tid; }
    }
    if (!tid) return null;
    if (!opp.club || !opp.rating) {
        const f = await factsFor(tid);
        if (!opp.club && f.club) patch.club = f.club;
        if (!opp.rating && f.rating) patch.rating = f.rating;
    }
    if (!Object.keys(patch).length) return null;
    await supa.from('opponents').update(patch).eq('id', opp.id);
    return patch;
}
export async function linkOpponentsByName(profile, opps) {
    const todo = (opps || []).filter((o) => !o.tracker_id);
    if (!todo.length) return;
    const list = await recentResultOpponents(profile);
    for (const o of todo) {
        const hit = matchResultOpponent(list, o.name);
        if (!hit?.tracker_id) continue;
        o.tracker_id = hit.tracker_id;
        try { await supa.from('opponents').update({ tracker_id: hit.tracker_id }).eq('id', o.id); } catch (e) { console.warn('link failed', e); }
    }
}

// Every result-row loss in the window, split into those already in the
// journal and those still to log. Logged bouts that match a result row get
// the facts they were missing, and never anything they already had.
export async function loadLostBouts(profile) {
    const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
    const [{ data: results }, { data: logged }] = await Promise.all([
        supa.from('fencer_bouts').select('*').eq('profile_id', profile.id).eq('result', 'D').gte('bout_date', since).order('bout_date', { ascending: false }).order('bout_no'),
        supa.from('bouts').select('id,date,my_score,their_score,opponent_name,opponent_tracker_id,source_bout_id,opponent_id,context,location,opponent_club,opponent_rating').eq('profile_id', profile.id).is('deleted_at', null).gte('date', since)
    ]);
    const rows = results || [];
    const journal = logged || [];
    const unlogged = [];
    const links = [];
    for (const f of rows) {
        const hits = journal.filter((b) =>
            b.source_bout_id === f.id ||
            (b.opponent_tracker_id && b.opponent_tracker_id === f.opponent_tracker_id && b.date === f.bout_date && b.my_score === f.score_for && b.their_score === f.score_against) ||
            (!b.source_bout_id && b.date === f.bout_date && b.my_score === f.score_for && b.their_score === f.score_against &&
                (!b.opponent_tracker_id || b.opponent_tracker_id === f.opponent_tracker_id) && nameClose(b.opponent_name, f.opponent)));
        if (!hits.length) unlogged.push(f);
        for (const b of hits) if (!b.source_bout_id) links.push({ b, f });
    }
    const snaps = await snapshotsFor(rows.map((f) => f.opponent_tracker_id));
    for (const { b, f } of links) {
        const s = snaps.get(f.opponent_tracker_id) || {};
        const patch = { source_bout_id: f.id };
        if (!b.opponent_tracker_id && f.opponent_tracker_id) patch.opponent_tracker_id = f.opponent_tracker_id;
        if (!b.opponent_club && s.club) patch.opponent_club = s.club;
        if (!b.opponent_rating && s.rating) patch.opponent_rating = s.rating;
        if (!b.context || b.context === 'club_open' || b.context === 'other') patch.context = stageOf(f);
        if (!b.location && f.tournament) patch.location = f.tournament;
        try {
            await supa.from('bouts').update(patch).eq('id', b.id);
            if (b.opponent_id && f.opponent_tracker_id) await supa.from('opponents').update({ tracker_id: f.opponent_tracker_id }).eq('id', b.opponent_id).is('tracker_id', null);
        } catch (e) { console.warn('link failed', e); }
    }
    return { unlogged, snaps, linked: links.length, total: rows.length, since };
}

// What the entry form starts with when a result row is chosen.
export async function seedFromResult(id) {
    const { data: f, error } = await supa.from('fencer_bouts').select('*').eq('id', id).maybeSingle();
    if (error || !f) return null;
    const s = await factsFor(f.opponent_tracker_id);
    const stage = stageOf(f);
    return {
        date: f.bout_date,
        context: stage,
        location: f.tournament || null,
        opponent_name: f.opponent,
        opponent_rating: s.rating || null,
        opponent_club: s.club || null,
        my_score: f.score_for,
        their_score: f.score_against,
        opponent_tracker_id: f.opponent_tracker_id || null,
        source_bout_id: f.id,
        fact: [f.tournament, catLabel(f.category), stageLabel(stage), f.difficulty ? `${f.difficulty.toLowerCase()} on the day` : null, f.opponent_strength ? `strength ${f.opponent_strength}` : null, f.place && f.field_size ? `he finished ${f.place} of ${f.field_size}` : null].filter(Boolean).join(' · ')
    };
}

// The card on the Bouts screen.
export function renderLostBoutsCard(profile, data) {
    if (!data || !data.total) return null;
    const card = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    card.appendChild(el('div', { class: 'label', style: { color: INK_MUTE } }, ['From the results']));
    const n = data.unlogged.length;
    card.appendChild(el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '24px', color: INK, margin: '4px 0 4px' } }, [
        n ? `${n} lost bout${n > 1 ? 's' : ''} not in the journal yet` : 'Every loss is in the journal'
    ]));
    card.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '0 0 8px', lineHeight: '1.5' } }, [
        n ? `Competition losses from the last ${DAYS} days, read from the results. The facts are filled in; ${profile.name} adds how the touches went and what he noticed.`
          : `Losses from the last ${DAYS} days of competition are logged and linked to the results.`
    ]));
    let lastHead = '';
    for (const f of data.unlogged) {
        const head = `${f.tournament} · ${fmt(f.bout_date)}`;
        if (head !== lastHead) {
            card.appendChild(el('div', { class: 'label', style: { color: INK_MUTE, margin: '10px 0 2px' } }, [head]));
            lastHead = head;
        }
        const s = data.snaps.get(f.opponent_tracker_id) || {};
        const tags = [s.rating, s.club, s.strength_de ? `strength ${s.strength_de}` : null, f.difficulty].filter(Boolean);
        const row = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '8px 0', borderTop: '1px solid var(--rule)' } });
        row.appendChild(el('div', { style: { minWidth: '0' } }, [
            el('div', { style: { color: INK, fontSize: '15px', fontWeight: '600' } }, [f.opponent || 'Unknown']),
            el('div', { class: 'label', style: { color: INK_MUTE, marginTop: '2px' } }, [[catLabel(f.category), stageLabel(stageOf(f)), ...tags].filter(Boolean).join(' · ')])
        ]));
        const btn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-mono-label' }, ['Log it']);
        btn.onclick = () => go('bouts/new', { from: f.id });
        row.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexShrink: '0' } }, [
            el('span', { class: 'num', style: { color: BAD, fontWeight: '700', fontSize: '16px' } }, [`${f.score_for}–${f.score_against}`]),
            btn
        ]));
        card.appendChild(row);
    }
    return card;
}

// Every meeting with one fencer, wins and losses, from the results.
export async function renderMeetingsCard(profile, opp) {
    if (!opp?.tracker_id) return null;
    const { data } = await supa.from('fencer_bouts').select('*').eq('profile_id', profile.id).eq('opponent_tracker_id', opp.tracker_id).order('bout_date', { ascending: false }).order('bout_no');
    const rows = data || [];
    if (!rows.length) return null;
    const w = rows.filter((r) => r.result === 'V').length, l = rows.length - w;
    const card = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    card.appendChild(el('div', { class: 'label', style: { color: INK_MUTE } }, ['Every time they met']));
    card.appendChild(el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '24px', color: w > l ? GOOD : l > w ? BAD : INK, margin: '4px 0 6px' } }, [`${w} won, ${l} lost`]));
    const last = rows[0];
    card.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '0 0 8px', lineHeight: '1.5' } }, [
        `From the competition results. Last met ${fmt(last.bout_date)} at ${last.tournament}${last.opponent_strength ? `; his strength then was ${last.opponent_strength}` : ''}.`
    ]));
    for (const r of rows) {
        const won = r.result === 'V';
        card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '6px 0', borderTop: '1px solid var(--rule)' } }, [
            el('div', {}, [
                el('span', { style: { color: INK, fontSize: '14px' } }, [`${fmt(r.bout_date)} · ${r.tournament}`]),
                el('div', { class: 'label', style: { color: INK_MUTE, marginTop: '2px' } }, [[catLabel(r.category), stageLabel(stageOf(r)), r.difficulty].filter(Boolean).join(' · ')])
            ]),
            el('span', { class: 'num', style: { color: won ? GOOD : BAD, fontWeight: '700', fontSize: '15px', whiteSpace: 'nowrap' } }, [`${won ? 'W' : 'L'} ${r.score_for}–${r.score_against}`])
        ]));
    }
    return card;
}

// Record against every opponent that has a tracker id, for the list screen.
export async function recordsByTracker(profile, tids) {
    const ids = [...new Set((tids || []).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    const { data } = await supa.from('fencer_bouts').select('opponent_tracker_id,result,bout_date').eq('profile_id', profile.id).in('opponent_tracker_id', ids);
    for (const r of data || []) {
        const cur = out.get(r.opponent_tracker_id) || { w: 0, l: 0, last: null };
        if (r.result === 'V') cur.w += 1; else cur.l += 1;
        if (!cur.last || r.bout_date > cur.last) cur.last = r.bout_date;
        out.set(r.opponent_tracker_id, cur);
    }
    return out;
}
