// Settings — the parent's controls. Which screens the kids' logins can see,
// and whether they see what a weekend costs. Some parents keep the money out
// of a twelve-year-old's head on purpose; that is a setting, not a default.

import { el, toast } from '../lib/util.js';
import { supa } from '../lib/supa.js';
import { getState } from '../lib/state.js';
import { isParent, loadVisibility } from '../lib/visibility.js';

const INK = 'var(--ink)';
// Literal: var(--ink-mute) composites below AA on the cream surface.
const INK_MUTE = '#6B7280';
const GOOD = '#1f7a1f';

export async function mountSettings(root) {
    root.appendChild(el('div', { style: { padding: '40px var(--gut) 8px' } }, [
        el('h1', { class: 'page-eyebrow' }, ['Settings']),
        el('div', { class: 'today-sub' }, [el('span', {}, ['PARENT'])])
    ]));
    if (!isParent()) {
        root.appendChild(el('div', { class: 'empty' }, [el('p', { class: 'empty-line' }, ['Settings are for the parent login.'])]));
        return;
    }
    const session = getState().session;
    const [{ data: home }, { data: profiles }] = await Promise.all([
        supa.from('household').select('*').maybeSingle(),
        supa.from('profiles').select('id,name,kind,role,login_user_id,birth_year').order('name')
    ]);

    // --- What the kids can see -------------------------------------------
    const card = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    card.appendChild(el('div', { class: 'label', style: { color: INK_MUTE } }, ['What the kids can see']));
    card.appendChild(el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '24px', color: INK, margin: '4px 0 6px' } }, ['Their own fencer, and only that']));
    card.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '0 0 12px', lineHeight: '1.5' } }, [
        'A kid\'s login sees his own bouts, training and plan, never a brother\'s or sister\'s. These three switches decide what else he sees. They are enforced in the database, not just hidden on the screen.'
    ]));
    const toggles = [
        ['kids_see_season', 'Competition planning', 'The Season screen: which weekends, the odds, the registered fencers. Off means the kid sees only training and bouts.'],
        ['kids_see_costs', 'Costs', 'Fares, hotels, per-person totals and points per dollar. Off keeps the money out of the kid\'s view; the plan still shows.'],
        ['kids_see_travel', 'Flight tracker', 'The Travel screen with fares and bookings.']
    ];
    for (const [key, title, sub] of toggles) {
        const on = Boolean(home?.[key]);
        const row = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '10px 0', borderTop: '1px solid var(--rule)' } });
        const btn = el('button', { type: 'button', class: 'btn btn-sm btn-mono-label ' + (on ? 'btn-primary' : 'btn-ghost'), style: { minWidth: '76px' }, 'aria-pressed': String(on) }, [on ? 'On' : 'Off']);
        btn.onclick = async () => {
            const next = btn.getAttribute('aria-pressed') !== 'true';
            btn.disabled = true;
            const { error } = await supa.from('household').update({ [key]: next, updated_at: new Date().toISOString() }).eq('owner_user_id', session.user.id);
            btn.disabled = false;
            if (error) { toast('Could not save: ' + error.message, 'error'); return; }
            btn.setAttribute('aria-pressed', String(next)); btn.textContent = next ? 'On' : 'Off';
            btn.className = 'btn btn-sm btn-mono-label ' + (next ? 'btn-primary' : 'btn-ghost');
            await loadVisibility();
            toast('Saved. Kids see the change on their next screen.');
        };
        row.appendChild(el('div', {}, [
            el('div', { style: { color: INK, fontSize: '15px', fontWeight: '600' } }, [title]),
            el('div', { style: { color: INK_MUTE, fontSize: '12px', lineHeight: '1.5', marginTop: '2px' } }, [sub])
        ]));
        row.appendChild(btn);
        card.appendChild(row);
    }
    root.appendChild(card);

    // --- Who is on this account -------------------------------------------
    const who = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    who.appendChild(el('div', { class: 'label', style: { color: INK_MUTE } }, ['Logins on this account']));
    who.appendChild(el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '24px', color: INK, margin: '4px 0 6px' } }, [session?.user?.email || 'Parent']));
    who.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '0 0 8px', lineHeight: '1.5' } }, ['The parent login owns every fencer below and sees everything. A fencer with a login of his own sees only himself.']));
    for (const p of (profiles || []).filter((x) => x.kind === 'fencer' || x.role !== 'parent')) {
        who.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '8px 0', borderTop: '1px solid var(--rule)' } }, [
            el('span', { style: { color: INK, fontSize: '14px', fontWeight: '600' } }, [p.name, p.birth_year ? el('span', { class: 'label', style: { color: INK_MUTE, marginLeft: '8px' } }, [`born ${p.birth_year}`]) : null].filter(Boolean)),
            el('span', { class: 'label', style: { color: p.login_user_id ? GOOD : INK_MUTE } }, [p.login_user_id ? 'Has his own login' : 'No login, parent only'])
        ]));
    }
    root.appendChild(who);
}
