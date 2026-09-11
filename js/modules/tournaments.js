// Tournaments — list + entry form. Powers the topbar countdown and module-level
// taper / mental-checklist triggers.

import { el, todayISO, fmtDate, fmtDateLong, daysUntil, toast } from '../lib/util.js';
import { activeProfile } from '../lib/state.js';
import { listTournaments } from '../lib/db.js';
import { safeWrite } from '../lib/offline.js';
import { chipArrayEditor } from '../lib/chips.js';
import { refreshTournamentCountdown } from '../views/shell.js';

export async function mountTournaments(root, params) {
    // Idempotent re-mount: clear root so internal calls (e.g. after save)
    // refresh cleanly instead of stacking content on top of the open form.
    root.innerHTML = '';
    const profile = activeProfile();
    if (!profile) return root.appendChild(el('div', { class: 'empty' }, ['Pick a profile.']));

    root.appendChild(el('div', { class: 'section-head' }, [
        el('h2', {}, ['Tournaments']),
        el('span', { class: 'meta' }, [profile.name])
    ]));

    const tournaments = await listTournaments();

    root.appendChild(el('div', { class: 'btn-row', style: { marginBottom: '12px' } }, [
        el('button', { class: 'btn', onclick: () => openForm() }, ['+ Add tournament']),
        tournaments.length === 0 ? el('button', { class: 'btn btn-ghost', onclick: () => openForm({
            name: 'Summer Nationals 2026',
            start_date: '2026-06-27', end_date: '2026-07-06',
            location: 'Portland, OR',
            events: (Number(profile.birth_year) >= 2014 || profile.role === 'kaylan') ? ['Y-12','Y-14'] : ['Y-14','Cadet']
        }) }, ['Quick-add Summer Nationals']) : null
    ]));

    const formMount = el('div', {});
    root.appendChild(formMount);

    if (!tournaments.length) {
        root.appendChild(el('div', { class: 'empty' }, ['No tournaments yet. Add one to enable the countdown.']));
    } else {
        for (const t of tournaments) {
            const d = daysUntil(t.start_date);
            const past = d < 0;
            const card = el('div', { class: 'card' + (past ? '' : ' bordered-accent') });
            card.appendChild(el('div', { class: 'card-head' }, [
                el('h3', {}, [t.name]),
                el('span', { class: 'card-meta' }, [past ? 'past' : (d === 0 ? 'today' : `${d} days`)])
            ]));
            card.appendChild(el('p', { class: 'kicker' }, [
                fmtDateLong(t.start_date),
                t.end_date && t.end_date !== t.start_date ? ' – ' + fmtDateLong(t.end_date) : '',
                t.location ? ' · ' + t.location : ''
            ]));
            if (t.events?.length) {
                card.appendChild(el('div', { class: 'chips', style: { marginTop: '8px' } },
                    t.events.map((e) => el('span', { class: 'chip on' }, [e]))));
            }
            if (t.notes) card.appendChild(el('p', { style: { marginTop: '10px' } }, [t.notes]));
            card.appendChild(el('div', { class: 'btn-row', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } }, [
                el('a', {
                    href: `#tournaments/day?id=${t.id}`,
                    class: 'btn btn-primary',
                    style: { flex: '1 1 auto', textDecoration: 'none', textAlign: 'center', fontSize: '14px', fontWeight: 700 }
                }, [past ? 'View pool / DE' : '🎯 Start Day']),
                el('button', { class: 'btn-link', onclick: () => openForm(t) }, ['edit']),
                el('button', { class: 'btn-link', style: { color: 'var(--danger)' }, onclick: async () => {
                    if (!confirm('Delete this tournament?')) return;
                    // Soft delete: gone from their view, but recoverable.
                    await safeWrite({
                        table: 'tournaments',
                        op: 'update',
                        payload: { deleted_at: new Date().toISOString() },
                        match: { id: t.id }
                    });
                    toast('Deleted');
                    await refreshTournamentCountdown();
                    mountTournaments(root, {});
                } }, ['delete'])
            ]));
            root.appendChild(card);
        }
    }

    function openForm(prefill) {
        formMount.innerHTML = '';
        const editing = prefill?.id ? prefill : null;
        const seed = prefill || {};
        const form = el('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); await save(); } });
        formMount.appendChild(form);

        form.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Name']), el('input', { type: 'text', name: 'name', value: seed.name || '', required: true })]));
        form.appendChild(el('div', { class: 'row' }, [
            el('div', { class: 'field' }, [el('label', {}, ['Start']), el('input', { type: 'date', name: 'start_date', value: seed.start_date || todayISO(), required: true })]),
            el('div', { class: 'field' }, [el('label', {}, ['End']), el('input', { type: 'date', name: 'end_date', value: seed.end_date || '' })])
        ]));
        form.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Location']), el('input', { type: 'text', name: 'location', value: seed.location || '' })]));
        form.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Events'])]));
        const events = chipArrayEditor({ values: seed.events || [], placeholder: 'e.g. Y-14, Cadet' });
        form.appendChild(events);
        form.appendChild(el('div', { class: 'field', style: { marginTop: '10px' } }, [el('label', {}, ['Notes']), el('textarea', { name: 'notes' }, [seed.notes || ''])]));

        form.appendChild(el('div', { class: 'btn-row right' }, [
            el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => formMount.innerHTML = '' }, ['Cancel']),
            el('button', { type: 'submit', class: 'btn' }, [editing ? 'Save changes' : 'Save tournament'])
        ]));

        let saving = false;
        async function save() {
            if (saving) return;  // prevent double-submit duplicates
            saving = true;
            const submitBtn = form.querySelector('button[type="submit"]');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }
            const fd = new FormData(form);
            const payload = {
                profile_id: profile.id,
                name: (fd.get('name') || '').toString().trim(),
                start_date: fd.get('start_date'),
                end_date: fd.get('end_date') || null,
                location: (fd.get('location') || '').toString().trim() || null,
                events: events.getValues(),
                notes: (fd.get('notes') || '').toString().trim() || null
            };
            try {
                if (editing) await safeWrite({ table: 'tournaments', op: 'update', payload, match: { id: editing.id } });
                else         await safeWrite({ table: 'tournaments', op: 'insert', payload });
                toast('Saved');
                formMount.innerHTML = '';  // close the form immediately
                await refreshTournamentCountdown();
                mountTournaments(root, {});  // re-render the list (root.innerHTML='' at top makes this clean)
            } catch (e) {
                toast('Save failed: ' + e.message, 'error');
                saving = false;
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = editing ? 'Save changes' : 'Save tournament'; }
            }
        }
    }
}
