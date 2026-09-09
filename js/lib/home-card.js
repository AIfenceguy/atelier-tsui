// Home. A parent types the address once; the Season screen prices every
// weekend from it - a drive when it is close enough, a flight otherwise, and a
// flat hotel estimate. Flights are tracked because they move; hotels are not.

import { el, toast } from './util.js';
import { supa } from './supa.js';

const INK = 'var(--ink, #1A1D24)';
// Literal: var(--ink-mute) composites below AA on the cream surface.
const INK_MUTE = '#6B7280';

export async function homeCard(session) {
    const wrap = el('section', { class: 'card', style: { marginTop: '12px' } });
    const { data: home } = await supa.from('household').select('*').maybeSingle();
    wrap.appendChild(el('div', { class: 'label', style: { color: INK_MUTE } }, ['Home · trips are priced from here']));
    const current = el('div', { style: { fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: '700', fontSize: '22px', color: INK, margin: '4px 0 8px' } }, [
        home?.home_city ? home.home_city : 'No home set yet'
    ]);
    wrap.appendChild(current);
    const addr = el('input', { type: 'text', class: 'field-input', placeholder: 'ZIP code, or street, city, state', value: home?.home_address || '', autocomplete: 'postal-code', style: { color: INK } });
    const hotel = el('input', { type: 'number', class: 'field-input', min: 100, max: 400, step: 10, value: String(home?.hotel_night ?? 180), style: { color: INK } });
    const btn = el('button', { class: 'btn btn-primary btn-mono-label', style: { width: '100%', marginTop: '10px' } }, [home ? 'Update home' : 'Save home']);
    const note = el('p', { style: { color: INK_MUTE, fontSize: '12px', margin: '8px 0 0', lineHeight: '1.5' } }, [
        'Hotel is an estimate only: $150 to $250 a night for a 3.5-star or better within walking distance of the venue. Fares come from the flight watches below.'
    ]);
    btn.onclick = async () => {
        const q = addr.value.trim();
        if (q.length < 5) { toast('Type the home address', 'error'); return; }
        btn.disabled = true; btn.textContent = 'Finding it…';
        try {
            const { data: g, error } = await supa.functions.invoke('geocode', { body: { q } });
            if (error || !g || g.lat == null) throw new Error(error?.message || g?.error || 'address not found');
            const st = q.match(/,\s*([A-Za-z]{2})\b/);
            const city = String(g.display_name || q).split(',')[0].trim() + (st ? ', ' + st[1].toUpperCase() : '');
            const row = { owner_user_id: session.user.id, home_address: q, home_city: city, home_lat: g.lat, home_lng: g.lng, hotel_night: Number(hotel.value) || 180, updated_at: new Date().toISOString() };
            const { error: werr } = await supa.from('household').upsert(row, { onConflict: 'owner_user_id' });
            if (werr) throw werr;
            current.textContent = city;
            toast('Home saved. The Season screen now prices trips from here.');
            btn.textContent = 'Update home';
        } catch (e) {
            toast('Could not save home: ' + (e.message || e), 'error');
            btn.textContent = home ? 'Update home' : 'Save home';
        }
        btn.disabled = false;
    };
    wrap.appendChild(el('div', { class: 'field' }, [el('label', { class: 'field-label', style: { color: INK } }, ['Home address']), addr]));
    wrap.appendChild(el('div', { class: 'field', style: { marginTop: '8px' } }, [el('label', { class: 'field-label', style: { color: INK } }, ['Hotel per night, estimate']), hotel]));
    wrap.appendChild(btn); wrap.appendChild(note);
    return wrap;
}
