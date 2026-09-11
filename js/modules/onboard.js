// First sign-in: set up the family. A parent, a home ZIP, one fencer. The
// parent's login owns everything; the fencer gets a profile now and a login
// of his own later from Settings. Everything else the app needs (goals, the
// season plan, the standings) hangs off the birth year and fills itself in.

import { el, toast } from '../lib/util.js';
import { supa } from '../lib/supa.js';
import { getState } from '../lib/state.js';
import { signOut } from '../lib/auth.js';
import { categoryFor, roleSlug, CATEGORY_LABEL } from '../lib/category.js';

const INK = 'var(--ink)';
// Literal: var(--ink-mute) composites below AA on the cream surface.
const INK_MUTE = '#6B7280';

export function mountOnboard(root, email) {
    root.innerHTML = '';
    document.body.classList.add('is-signed-out');
    const thisYear = new Date().getFullYear();
    const wrap = el('div', { class: 'auth', style: { textAlign: 'left' } });
    wrap.appendChild(el('div', { class: 'auth-mark' }, [el('h1', { class: 'wordmark wordmark-lg' }, ['En Garde'])]));
    wrap.appendChild(el('div', { class: 'label', style: { color: INK_MUTE, marginTop: '18px' } }, ['Set up your family']));
    wrap.appendChild(el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '26px', color: INK, margin: '4px 0 6px' } }, ['One parent, one fencer, one home']));
    wrap.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '0 0 14px', lineHeight: '1.5' } }, [
        `You are signed in as ${email || 'this account'}. This login becomes the parent login and sees everything. A fencer can be given a login of his own later, in Settings, and will see only his own fencing.`
    ]));

    const field = (labelText, input) => el('div', { class: 'field' }, [el('label', { class: 'field-label' }, [labelText]), input]);
    const parentName = el('input', { type: 'text', class: 'field-input', placeholder: 'Your name', autocomplete: 'name', value: '' });
    const zip = el('input', { type: 'text', class: 'field-input', placeholder: '91748', inputmode: 'numeric', maxlength: 5, autocomplete: 'postal-code' });
    const fencerName = el('input', { type: 'text', class: 'field-input', placeholder: 'Fencer\'s first name', autocomplete: 'off' });
    const birth = el('select', { class: 'field-input' }, [
        el('option', { value: '' }, ['Birth year']),
        ...Array.from({ length: 14 }, (_, i) => thisYear - 6 - i).map((y) => el('option', { value: String(y) }, [`${y} · ${CATEGORY_LABEL[categoryFor(y)] || ''}`]))
    ]);
    const weapon = el('select', { class: 'field-input' }, [['foil', 'Foil'], ['epee', 'Épée'], ['saber', 'Saber']].map(([v, t]) => el('option', { value: v }, [t])));
    const tracker = el('input', { type: 'text', class: 'field-input', placeholder: 'https://fencingtracker.com/p/1003…/… (optional)', autocomplete: 'off' });

    wrap.appendChild(el('div', { class: 'auth-form' }, [
        el('div', { class: 'label-row' }, [el('span', { class: 'label' }, ['Parent'])]),
        field('Name', parentName),
        field('Home ZIP', zip),
        el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '2px 0 14px', lineHeight: '1.5' } }, ['Trips are priced from home: drive or fly, which airports, how many nights.']),
        el('div', { class: 'label-row' }, [el('span', { class: 'label' }, ['First fencer'])]),
        field('Name', fencerName),
        field('Born', birth),
        field('Weapon', weapon),
        field('Results profile link', tracker),
        el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '2px 0 14px', lineHeight: '1.5' } }, ['Optional. With it the app can read his entry lists and bouts. His USA Fencing record is matched by name and birth year when the standings are read.']),
        (() => {
            const btn = el('button', { type: 'button', class: 'btn btn-primary btn-block btn-mono-label', style: { marginTop: '10px' } }, ['Start']);
            btn.onclick = async () => {
                const pName = parentName.value.trim() || 'Parent';
                const fName = fencerName.value.trim();
                const by = Number(birth.value);
                if (!fName || !by) { toast('The fencer needs a name and a birth year', 'error'); return; }
                const z = zip.value.trim();
                if (z && !/^\d{5}$/.test(z)) { toast('ZIP is five digits', 'error'); return; }
                const m = String(tracker.value).match(/\/p\/(\d{6,10})/);
                btn.disabled = true; btn.textContent = 'Setting up…';
                try {
                    const uid = getState().session.user.id;
                    const { error: e1 } = await supa.from('profiles').insert({ owner_user_id: uid, name: pName, role: 'parent', kind: 'parent', accent_hex: '#5a7a8c' });
                    if (e1) throw e1;
                    const { data: fencer, error: e2 } = await supa.from('profiles').insert({
                        owner_user_id: uid, name: fName, role: roleSlug(fName), kind: 'fencer', birth_year: by, primary_weapon: weapon.value,
                        accent_hex: '#a82b2b', tracker_id: m ? m[1] : null, tracker_url: m ? tracker.value.trim() : null
                    }).select().single();
                    if (e2) throw e2;
                    if (z) { const { error: e3 } = await supa.from('household').upsert({ owner_user_id: uid, home_zip: z, hotel_night: 180, updated_at: new Date().toISOString() }); if (e3) throw e3; }
                    const cat = categoryFor(by);
                    await supa.from('fencer_goals').upsert({ profile_id: fencer.id, season: '2026-27', focus_category: cat, secondary: [], ride_along: [], pressure: 'development', updated_at: new Date().toISOString() });
                    localStorage.setItem('en-garde.activeProfileId', fencer.id);
                    location.reload();
                } catch (err) {
                    btn.disabled = false; btn.textContent = 'Start';
                    toast('Could not set up: ' + (err.message || err), 'error');
                }
            };
            return btn;
        })(),
        el('div', { class: 'auth-foot', style: { marginTop: '16px' } }, [
            'Wrong account? ',
            el('a', { href: '#', onclick: (e) => { e.preventDefault(); signOut(); }, style: { color: INK } }, ['Sign out'])
        ])
    ]));
    root.appendChild(wrap);
}
