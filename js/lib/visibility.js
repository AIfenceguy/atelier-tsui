// What this login may see, decided by the parent in Settings and enforced by
// the database. The parent's login is the master: it sees every fencer on the
// household. A kid's login is attached to one fencer and sees only that, and
// only the screens the parent has switched on for kids: competition planning,
// the flight tracker, and costs. This module just reads the answer once and
// stamps it on <body> so the nav and the screens can follow it.

import { supa } from './supa.js';

let VIS = { is_parent: true, see_season: true, see_travel: true, see_costs: true, loaded: false };

export async function loadVisibility() {
    try {
        const { data, error } = await supa.rpc('my_visibility');
        if (!error && data) VIS = { ...VIS, ...data, loaded: true };
    } catch (e) { console.warn('visibility unavailable, defaulting open', e); }
    const b = document.body;
    b.setAttribute('data-parent', VIS.is_parent ? '1' : '0');
    b.setAttribute('data-see-season', VIS.see_season ? '1' : '0');
    b.setAttribute('data-see-travel', VIS.see_travel ? '1' : '0');
    b.setAttribute('data-see-costs', VIS.see_costs ? '1' : '0');
    return VIS;
}

export function visibility() { return VIS; }
export const isParent = () => VIS.is_parent;
export const canSeeCosts = () => VIS.is_parent || VIS.see_costs;
export const canSeeSeason = () => VIS.is_parent || VIS.see_season;
export const canSeeTravel = () => VIS.is_parent || VIS.see_travel;
