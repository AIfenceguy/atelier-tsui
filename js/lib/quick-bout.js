// Quick bout log — the whole point is that it fits in the gap between bouts.
//
// The full entry form asks for twelve things across eight sections, including a
// per-tactic tally where every touch is marked attempted and then landed. It is
// a good debrief form and a hopeless capture form: at a tournament there is
// maybe a minute between bouts, on a phone, with a bag in the other hand. Zero
// bouts have ever been logged, which is the form telling us so.
//
// So: score and save. Two taps per touch, one to save. Everything else the full
// form asks for is real but can be added afterwards from the couch, and a bout
// with only a score still feeds the win rate, the opponent history and the
// question of which skills survive pressure.

import { el, todayISO, toast } from './util.js';
import { safeWrite } from './offline.js';

const INK = 'var(--ink, #1A1D24)';
const INK_MUTE = '#6B7280';

export function quickBout({ profile, onSaved }) {
    let mine = 0;
    let theirs = 0;

    const myNum = el('span', { class: 'tap-counter-num' }, ['0']);
    const themNum = el('span', { class: 'tap-counter-num' }, ['0']);
    const verdict = el('div', {
        style: {
            textAlign: 'center', fontFamily: 'var(--eg-mono, monospace)',
            fontSize: '12px', fontWeight: '700', letterSpacing: '0.08em',
            textTransform: 'uppercase', color: INK_MUTE, minHeight: '18px', marginTop: '2px'
        }
    }, ['tap to score']);

    const paint = () => {
        myNum.textContent = String(mine);
        themNum.textContent = String(theirs);
        if (mine === 0 && theirs === 0) {
            verdict.textContent = 'tap to score';
            verdict.style.color = INK_MUTE;
        } else if (mine > theirs) {
            verdict.textContent = `win ${mine}–${theirs}`;
            verdict.style.color = '#1f7a1f';
        } else if (theirs > mine) {
            verdict.textContent = `loss ${mine}–${theirs}`;
            verdict.style.color = '#9b2230';
        } else {
            verdict.textContent = `tied ${mine}–${theirs}`;
            verdict.style.color = '#B45309';
        }
    };

    const bump = (who, delta) => {
        if (who === 'me') mine = Math.max(0, Math.min(30, mine + delta));
        else theirs = Math.max(0, Math.min(30, theirs + delta));
        paint();
        // A touch is a physical event; the phone should feel like it registered.
        if (navigator.vibrate) navigator.vibrate(10);
    };

    const counter = (label, who, numEl, kind) => el('div', { class: 'tap-counter ' + kind }, [
        el('div', { class: 'tap-counter-label' }, [label]),
        numEl,
        el('div', { class: 'tap-counter-buttons' }, [
            el('button', { type: 'button', class: 'tap-counter-btn tap-counter-minus',
                           'aria-label': `${label} minus one`,
                           onclick: () => bump(who, -1) }, ['−']),
            el('button', { type: 'button', class: 'tap-counter-btn tap-counter-plus',
                           'aria-label': `${label} plus one`,
                           onclick: () => bump(who, +1) }, ['+'])
        ])
    ]);

    const opponent = el('input', {
        type: 'text', class: 'field-input', placeholder: 'Opponent (optional)',
        autocomplete: 'off', style: { marginTop: '10px' }
    });

    const saveBtn = el('button', {
        type: 'button', class: 'btn btn-primary btn-mono-label',
        style: { width: '100%', marginTop: '10px' }
    }, ['Save bout']);

    saveBtn.onclick = async () => {
        if (mine === 0 && theirs === 0) {
            toast('Score the bout first', 'error');
            return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        // Only the columns the database actually requires, plus what two taps
        // can honestly fill in. scoring_actions is NOT NULL with no default in
        // some environments, so it is sent explicitly rather than assumed.
        // Through safeWrite, like every other form: on venue wifi a dropped
        // request is queued and sent when the connection returns, instead of
        // a "Could not save" toast and a lost score - which is what happened
        // at Fortune. The banner at the top shows anything still waiting.
        let res;
        try {
            res = await safeWrite({ table: 'bouts', op: 'insert', payload: {
                profile_id: profile.id,
                date: todayISO(),
                my_score: mine,
                their_score: theirs,
                outcome: mine > theirs ? 'win' : theirs > mine ? 'loss' : 'draw',
                opponent_name: opponent.value.trim() || null,
                scoring_actions: []
            } });
        } catch (e) {
            toast('Could not save: ' + (e.message || e), 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save bout';
            return;
        }
        toast(res?.offline ? 'Bout saved on this phone \u2014 it will send when the wifi is back' : 'Bout logged');
        mine = 0; theirs = 0; opponent.value = '';
        paint();
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save bout';
        if (onSaved) onSaved();
    };

    paint();

    return el('div', {
        class: 'card',
        style: { margin: '0 var(--gut) 18px', padding: '14px 16px' }
    }, [
        el('div', { class: 'kicker', style: { color: INK_MUTE } }, ['Quick log']),
        el('div', { style: { color: INK_MUTE, fontSize: '13px', margin: '2px 0 10px' } }, [
            'Score it now, add the detail later.'
        ]),
        el('div', { class: 'tap-counter-row' }, [
            counter('YOU', 'me', myNum, 'tap-counter-you'),
            counter('THEM', 'theirs', themNum, 'tap-counter-them')
        ]),
        verdict,
        el('button', {
            type: 'button',
            style: {
                background: 'transparent', border: 'none', padding: '6px 0', cursor: 'pointer',
                fontFamily: 'var(--eg-mono, monospace)', fontSize: '11px', fontWeight: '700',
                letterSpacing: '0.12em', textTransform: 'uppercase', color: '#6B7280',
                width: '100%', textAlign: 'center'
            },
            // The two counters sit side by side and get tapped the wrong way
            // round. One tap fixes it instead of delete-and-redo.
            onclick: () => { const t = mine; mine = theirs; theirs = t; paint(); }
        }, ['Swap sides']),
        opponent,
        saveBtn,
        el('div', { style: { textAlign: 'center', marginTop: '8px' } }, [
            el('a', {
                href: '#bouts/new',
                style: { color: INK_MUTE, fontSize: '12px', fontFamily: 'var(--eg-mono, monospace)' }
            }, ['or log the full debrief →'])
        ])
    ]);
}
