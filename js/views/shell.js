// Sign-in view (shown when no session) and the topbar countdown updater.

import { el } from '../lib/util.js';
import { signInWithGoogle, signInWithPassword, signOut } from '../lib/auth.js';
import { mountOnboard } from '../modules/onboard.js';
import { isConfigured } from '../lib/supa.js';
import { nextTournament } from '../lib/db.js';
import { daysUntil, fmtDate } from '../lib/util.js';

export function renderSignIn(root) {
    root.innerHTML = '';
    document.body.classList.add('is-signed-out');

    const wrap = el('div', { class: 'auth' }, [
        el('div', { class: 'auth-mark' }, [
            el('h1', { class: 'wordmark wordmark-lg' }, ['En Garde']),
            el('div', { class: 'auth-mark-sub' }, ['A family studio · foil · est. 2025'])
        ]),
        el('p', { class: 'auth-tagline' }, [
            'A private journal for the work between bouts — yours, theirs, and what was learned.'
        ]),
        !isConfigured()
            ? el('div', { class: 'card', style: { marginTop: '24px' } }, [
                el('div', { class: 'label' }, ['Setup needed']),
                el('p', { style: { marginTop: '8px' } }, [
                    'Edit ',
                    el('code', {}, ['js/lib/config.js']),
                    ' with your Supabase project URL and anon key. See the README.'
                ])
            ])
            : null,
        el('div', { class: 'auth-form' }, [
            el('div', { class: 'label-row' }, [
                el('span', { class: 'label' }, ['Sign in'])
            ]),
            el('div', { class: 'field' }, [
                el('label', { class: 'field-label' }, ['Email']),
                el('input', {
                    type: 'email',
                    id: 'magic-email',
                    class: 'field-input',
                    placeholder: 'you@studio',
                    autocomplete: 'email',
                    autocapitalize: 'off',
                    spellcheck: 'false',
                    value: localStorage.getItem('en-garde.lastEmail') || ''
                })
            ]),
            el('div', { class: 'field' }, [
                el('label', { class: 'field-label' }, ['Password']),
                el('input', {
                    type: 'password',
                    id: 'pw-input',
                    class: 'field-input',
                    placeholder: '••••••••',
                    autocomplete: 'current-password'
                })
            ]),
            el('button', {
                class: 'btn btn-primary btn-block btn-mono-label',
                style: { marginTop: '20px' },
                onclick: async (e) => {
                    const email = document.getElementById('magic-email').value.trim();
                    const pw = document.getElementById('pw-input').value;
                    if (!email || !pw) { alert('Email and password required'); return; }
                    const btn = e.currentTarget;
                    const orig = btn.textContent;
                    btn.disabled = true;
                    btn.textContent = 'Signing in…';
                    try {
                        await signInWithPassword(email, pw);
                        localStorage.setItem('en-garde.lastEmail', email);
                        location.reload();
                    } catch (err) {
                        btn.textContent = orig;
                        btn.disabled = false;
                        alert('Sign-in failed: ' + err.message);
                    }
                }
            }, ['Sign in']),
            el('div', { class: 'auth-divider' }, ['or']),
            el('button', {
                class: 'btn btn-ghost btn-block',
                disabled: !isConfigured(),
                onclick: async () => {
                    try { await signInWithGoogle(); }
                    catch (e) { alert('Sign-in failed: ' + e.message); }
                }
            }, ['Continue with Google']),
            el('div', { class: 'auth-foot' }, [
                'One family · private by default · ',
                el('a', { href: 'legal.html#terms', style: { color: 'inherit' } }, ['Terms']),
                ' · ',
                el('a', { href: 'legal.html#privacy', style: { color: 'inherit' } }, ['Privacy'])
            ])
        ])
    ]);
    root.appendChild(wrap);
}

/**
 * Signed in, but this account has no fencer attached.
 *
 * The account email is the whole point of this screen: the cause is almost
 * always the wrong Google account, and naming it turns a confusing empty app
 * into an obvious "oh, wrong login".
 */
export function renderNoProfile(root, email) {
    // A signed-in account with no fencer is a new family: set it up here.
    return mountOnboard(root, email);
}

export function renderNoProfileLegacy(root, email) {
    root.innerHTML = '';
    document.body.classList.add('is-signed-out');

    const INK = 'var(--ink, #1A1D24)';
    const MUTE = '#6B7280';

    root.appendChild(el('div', { class: 'auth' }, [
        el('div', { class: 'auth-mark' }, [
            el('h1', { class: 'wordmark wordmark-lg' }, ['En Garde'])
        ]),
        el('div', { class: 'card', style: { marginTop: '20px', textAlign: 'left' } }, [
            el('div', { class: 'label', style: { color: INK } }, ['No fencer on this account']),
            el('p', { style: { color: INK, fontSize: '14px', lineHeight: '1.6', marginTop: '10px' } }, [
                'You are signed in as ',
                el('strong', { style: { color: INK } }, [email || 'this account']),
                ', but no fencer is set up under it.'
            ]),
            el('p', { style: { color: MUTE, fontSize: '14px', lineHeight: '1.6', marginTop: '10px' } }, [
                'This usually means a different Google account was picked by mistake. ',
                'Sign out and sign back in with your own login — your logs are safe on the right account.'
            ]),
            el('button', {
                class: 'btn btn-primary btn-block btn-mono-label',
                style: { marginTop: '18px' },
                onclick: () => signOut()
            }, ['Sign out'])
        ])
    ]));
}

export async function refreshTournamentCountdown() {
    const node = document.getElementById('tournament-countdown');
    if (!node) return;
    try {
        const t = await nextTournament();
        if (!t) { node.innerHTML = ''; return; }
        const d = daysUntil(t.start_date);
        if (d < 0) { node.innerHTML = ''; return; }
        node.innerHTML = '';
        const isTaper = d >= 0 && d <= 5;
        node.className = 'countdown' + (isTaper ? ' taper' : '');
        node.appendChild(el('span', { class: 'label' }, [t.name.length > 18 ? t.name.slice(0, 16) + '…' : t.name, ' · ']));
        node.appendChild(el('span', { class: 'num' }, [d === 0 ? 'today' : `${d}d`]));
    } catch (e) {
        node.innerHTML = '';
    }
}
