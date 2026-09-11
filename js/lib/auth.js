// Auth flow. Single family Google account.
// On first sign-in, default profiles (raedyn, kaylan, parent) are auto-created.

import { supa, isConfigured } from './supa.js';
import { setState, getState } from './state.js';
import { REDIRECT_TO } from './config.js';
import { loadVisibility } from './visibility.js';

export async function loadSession() {
    if (!isConfigured()) {
        setState({ session: null });
        return null;
    }
    const { data } = await supa.auth.getSession();
    setState({ session: data.session || null });
    return data.session || null;
}

export async function signInWithGoogle() {
    const redirectTo = REDIRECT_TO || (window.location.origin + window.location.pathname);
    const { error } = await supa.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo }
    });
    if (error) throw error;
}

export async function signInWithMagicLink(email) {
    const redirectTo = REDIRECT_TO || (window.location.origin + window.location.pathname);
    const { error } = await supa.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo }
    });
    if (error) throw error;
}

export async function signInWithPassword(email, password) {
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
}

export async function setPassword(password) {
    const { data, error } = await supa.auth.updateUser({ password });
    if (error) throw error;
    return data;
}


export async function signOut() {
    // Never let a failed network call strand someone in a signed-in shell:
    // clear the stored session regardless, then hard-navigate.
    try {
        await supa.auth.signOut({ scope: 'local' });
    } catch (e) {
        console.warn('[auth] signOut call failed, clearing locally anyway', e);
    }
    try {
        localStorage.removeItem('en-garde-tsui-auth');
        localStorage.removeItem('en-garde.activeProfileId');
    } catch (_) { /* private mode */ }

    setState({ session: null, profiles: [], activeProfileId: null });
    document.body.setAttribute('data-active-role', '');

    // replace() rather than hash + reload: that left the URL sitting on a bare
    // "#" and reloaded into the same cached view.
    location.replace(location.pathname);
}

// Reference only. Profiles are NOT created from this any more - see the note
// in loadOrCreateProfiles about the shadow family that auto-seeding produced.
// A new fencer is added deliberately, not as a side effect of signing in.
export const DEFAULT_PROFILES = [
    { name: 'Raedyn', role: 'raedyn', birth_year: 2012, primary_weapon: 'foil', accent_hex: '#a82b2b' },
    { name: 'Kaylan', role: 'kaylan', birth_year: 2014, primary_weapon: 'foil', accent_hex: '#d4af37' },
    { name: 'Parent', role: 'parent', accent_hex: '#5a7a8c' }
];

export async function loadOrCreateProfiles(userId) {
    // RLS returns the profiles this user may see: a fencer signing in with
    // their own login gets exactly one row; the parent account gets all three.
    const { data: existing, error } = await supa
        .from('profiles')
        .select('*')
        .order('role');
    if (error) throw error;

    const profiles = existing || [];
    // What this login may see: the parent sees everything, a kid sees his own
    // fencer plus whichever screens the parent switched on in Settings.
    await loadVisibility();

    // Deliberately NOT auto-creating profiles for an unrecognised account.
    //
    // This used to seed a fresh Raedyn/Kaylan/Parent set whenever an account
    // had none. On 2026-08-21 someone tapped "Continue with Google" and picked
    // rtsui0612@gmail.com; that account got its own silent copy of the family,
    // and a video plus two private lessons were logged into it where the
    // parent account could not see them. Nothing was lost, but it looked
    // exactly like data loss, which is worse than an error message.
    //
    // An account with no profiles now says so, and says which account it is,
    // so the wrong-login mistake is visible instead of invisible.
    if (!profiles.length) {
        setState({ profiles: [], activeProfileId: null });
        return [];
    }
    // Fencers first, oldest to youngest, the parent last.
    const key = (p) => (p.kind === 'parent' || p.role === 'parent') ? [1, ''] : [0, String(p.birth_year || '9999') + p.name];
    profiles.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || String(x[1]).localeCompare(String(y[1])); });
    setState({ profiles });

    // A fencer signing in with their own account is pinned to their profile —
    // no switching to a sibling's journal. The parent account still chooses.
    const own = profiles.find((p) => p.login_user_id === userId);
    if (own && profiles.length === 1) {
        setState({ activeProfileId: own.id });
        localStorage.setItem('en-garde.activeProfileId', own.id);
        applyActiveRole();
        return profiles;
    }

    // restore last active profile from localStorage
    const last = localStorage.getItem('en-garde.activeProfileId');
    const validLast = last && profiles.some((p) => p.id === last);
    setState({ activeProfileId: validLast ? last : (profiles[0]?.id || null) });
    applyActiveRole();
    return profiles;
}

export function setActiveProfile(profileId) {
    const { profiles } = getState();
    if (!profiles.some((p) => p.id === profileId)) return;
    setState({ activeProfileId: profileId });
    localStorage.setItem('en-garde.activeProfileId', profileId);
    applyActiveRole();
}

function applyActiveRole() {
    const { profiles, activeProfileId } = getState();
    const p = profiles.find((x) => x.id === activeProfileId);
    document.body.setAttribute('data-active-role', p?.role || '');
}
