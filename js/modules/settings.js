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
    root.appendChild(fencersCard(session, profiles || []));
}

// --- Fencers on the account: add one, fix his details, give him a login ----
function fencersCard(session, profiles) {
    const card = el('section', { class: 'card', style: { margin: '0 var(--gut) 18px' } });
    card.appendChild(el('div', { class: 'label', style: { color: INK_MUTE } }, ['Fencers']));
    card.appendChild(el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '24px', color: INK, margin: '4px 0 6px' } }, ['Who is on the account']));
    card.appendChild(el('p', { style: { color: INK_MUTE, fontSize: '13px', margin: '0 0 8px', lineHeight: '1.5' } }, [
        'Birth year sets the categories and the plan. The USA Fencing id is matched from the standings by name and birth year when you read them; the results profile link lets the app read entry lists and bouts.'
    ]));
    const field = (labelText, input) => el('div', { class: 'field', style: { marginBottom: '6px' } }, [el('label', { class: 'field-label' }, [labelText]), input]);
    const fencers = profiles.filter((p) => p.kind === 'fencer');
    for (const p of fencers) {
        const box = el('div', { style: { padding: '10px 0', borderTop: '1px solid var(--rule)' } });
        const name = el('input', { type: 'text', class: 'field-input', value: p.name || '' });
        const by = el('input', { type: 'number', class: 'field-input', value: p.birth_year || '', min: '2005', max: '2020' });
        const usaf = el('input', { type: 'text', class: 'field-input', value: p.usaf_user_id || '', placeholder: 'matched automatically from the standings', inputmode: 'numeric' });
        const tracker = el('input', { type: 'text', class: 'field-input', value: p.tracker_url || (p.tracker_id ? `https://fencingtracker.com/p/${p.tracker_id}/x` : ''), placeholder: 'results profile link (optional)' });
        box.appendChild(el('div', { style: { color: INK, fontSize: '15px', fontWeight: '600', marginBottom: '6px' } }, [p.name, el('span', { class: 'label', style: { color: p.login_user_id ? GOOD : INK_MUTE, marginLeft: '10px' } }, [p.login_user_id ? 'has a login' : 'no login yet'])]));
        box.appendChild(field('Name', name)); box.appendChild(field('Born', by)); box.appendChild(field('USA Fencing id', usaf)); box.appendChild(field('Results profile link', tracker));
        const save = el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-mono-label' }, ['Save']);
        save.onclick = async () => {
            save.disabled = true;
            const m = String(tracker.value).match(/\/p\/(\d{6,10})/);
            const { error } = await supa.from('profiles').update({ name: name.value.trim() || p.name, birth_year: Number(by.value) || null, usaf_user_id: Number(usaf.value) || null, tracker_url: tracker.value.trim() || null, tracker_id: m ? m[1] : p.tracker_id }).eq('id', p.id);
            save.disabled = false;
            if (error) { toast('Could not save: ' + error.message, 'error'); return; }
            toast('Saved'); location.reload();
        };
        const row = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' } }, [save]);
        if (!p.login_user_id) {
            const email = el('input', { type: 'email', class: 'field-input', placeholder: 'email for his login', autocomplete: 'off', style: { flex: '1 1 180px' } });
            const pw = el('input', { type: 'password', class: 'field-input', placeholder: 'password, 8 or more', autocomplete: 'new-password', style: { flex: '1 1 140px' } });
            const mk = el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-mono-label' }, ['Create his login']);
            mk.onclick = async () => {
                if (!email.value.trim() || pw.value.length < 8) { toast('Email and a password of 8 or more', 'error'); return; }
                mk.disabled = true; mk.textContent = 'Creating…';
                try {
                    const { data, error } = await supa.functions.invoke('kid-login', { body: { profile_id: p.id, email: email.value.trim(), password: pw.value } });
                    if (error || data?.error) throw new Error(error?.message || data?.error);
                    toast(`${p.name} can sign in with ${email.value.trim()}`); location.reload();
                } catch (err) { mk.disabled = false; mk.textContent = 'Create his login'; toast('Could not create: ' + (err.message || err), 'error'); }
            };
            row.appendChild(el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', flex: '1 1 100%', marginTop: '6px' } }, [email, pw, mk]));
        }
        box.appendChild(row);
        card.appendChild(box);
    }
    // Add a fencer.
    const add = el('div', { style: { padding: '12px 0 4px', borderTop: '1px solid var(--rule)' } });
    add.appendChild(el('div', { class: 'label', style: { color: INK_MUTE, marginBottom: '6px' } }, ['Add a fencer']));
    const nName = el('input', { type: 'text', class: 'field-input', placeholder: 'First name' });
    const nBy = el('input', { type: 'number', class: 'field-input', placeholder: 'Birth year', min: '2005', max: '2020' });
    const nTracker = el('input', { type: 'text', class: 'field-input', placeholder: 'results profile link (optional)' });
    const nBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm btn-mono-label', style: { marginTop: '6px' } }, ['Add']);
    nBtn.onclick = async () => {
        const nm = nName.value.trim(), b = Number(nBy.value);
        if (!nm || !b) { toast('Name and birth year', 'error'); return; }
        nBtn.disabled = true;
        const m = String(nTracker.value).match(/\/p\/(\d{6,10})/);
        const role = nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'fencer';
        const { data: f, error } = await supa.from('profiles').insert({ owner_user_id: session.user.id, name: nm, role, kind: 'fencer', birth_year: b, primary_weapon: 'foil', accent_hex: '#d4af37', tracker_id: m ? m[1] : null, tracker_url: m ? nTracker.value.trim() : null }).select().single();
        if (error) { nBtn.disabled = false; toast('Could not add: ' + error.message, 'error'); return; }
        const cat = b >= 2016 ? 'y10' : b >= 2014 ? 'y12' : b >= 2012 ? 'y14' : b >= 2010 ? 'cadet' : 'junior';
        await supa.from('fencer_goals').upsert({ profile_id: f.id, season: '2026-27', focus_category: cat, secondary: [], ride_along: [], pressure: 'development', updated_at: new Date().toISOString() });
        toast(`${nm} added`); location.reload();
    };
    add.appendChild(field('Name', nName)); add.appendChild(field('Born', nBy)); add.appendChild(field('Results profile link', nTracker)); add.appendChild(nBtn);
    card.appendChild(add);
    return card;
}
