// Shared DB helpers: taxonomy loaders + scoped query factories.

import { supa } from './supa.js';
import { getState, activeProfile } from './state.js';

let _taxoCache = null;

export async function loadTaxonomies(force = false) {
    if (_taxoCache && !force) return _taxoCache;
    const [topics, drills, tactics] = await Promise.all([
        supa.from('topic_taxonomy').select('*').order('label'),
        supa.from('drill_taxonomy').select('*').order('label'),
        supa.from('tactic_taxonomy').select('*').order('label')
    ]);
    if (topics.error) throw topics.error;
    if (drills.error) throw drills.error;
    if (tactics.error) throw tactics.error;
    _taxoCache = {
        topics: topics.data || [],
        drills: drills.data || [],
        tactics: tactics.data || [],
        topicBySlug: new Map((topics.data || []).map((r) => [r.slug, r])),
        drillBySlug: new Map((drills.data || []).map((r) => [r.slug, r])),
        tacticBySlug: new Map((tactics.data || []).map((r) => [r.slug, r]))
    };
    return _taxoCache;
}

export function invalidateTaxonomies() { _taxoCache = null; }

export function activeProfileId() {
    return getState().activeProfileId;
}

export function requireActiveProfile() {
    const p = activeProfile();
    if (!p) throw new Error('No active profile selected.');
    return p;
}

// Bouts
export async function listBouts({ limit = 30, opponentId = null } = {}) {
    const pid = activeProfileId();
    if (!pid) return [];
    // .is('deleted_at', null) everywhere: rows are soft-deleted, so without this
    // filter "deleted" entries would reappear in every list.
    let q = supa.from('bouts').select('*').eq('profile_id', pid).is('deleted_at', null).order('date', { ascending: false }).order('created_at', { ascending: false }).limit(limit);
    if (opponentId) q = q.eq('opponent_id', opponentId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
}

export async function getBout(id) {
    const { data, error } = await supa.from('bouts').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
}

// Opponents
export async function listOpponents() {
    const pid = activeProfileId();
    if (!pid) return [];
    const { data, error } = await supa
        .from('opponents')
        .select('*')
        .eq('profile_id', pid)
        .is('deleted_at', null)
        .order('name');
    if (error) throw error;
    return data || [];
}

export async function getOpponent(id) {
    const { data, error } = await supa.from('opponents').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
}

// One record per fencer. A FencingTracker id is the surest match; the name is
// the fallback (case-insensitive). An existing record picks up whatever it was
// missing - club, rating, the tracker id - and never loses what was typed.
export async function findOrCreateOpponent({ name, club = null, rating = null, tracker_id = null }) {
    const pid = activeProfileId();
    if (!pid) throw new Error('No profile.');
    const trimName = (name || '').trim();
    if (!trimName && !tracker_id) return null;
    let found = null;
    if (tracker_id) {
        const { data, error } = await supa.from('opponents').select('*').eq('profile_id', pid).eq('tracker_id', tracker_id).is('deleted_at', null).limit(1);
        if (error) throw error;
        found = data && data[0] ? data[0] : null;
    }
    if (!found && trimName) {
        const { data, error } = await supa.from('opponents').select('*').eq('profile_id', pid).ilike('name', trimName).is('deleted_at', null).limit(1);
        if (error) throw error;
        found = data && data[0] ? data[0] : null;
    }
    if (found) {
        const patch = {};
        if (!found.club && club) patch.club = club;
        if (!found.rating && rating) patch.rating = rating;
        if (!found.tracker_id && tracker_id) patch.tracker_id = tracker_id;
        if (Object.keys(patch).length) {
            const { data } = await supa.from('opponents').update(patch).eq('id', found.id).select().single();
            if (data) found = data;
        }
        return found;
    }
    const { data: created, error: e2 } = await supa
        .from('opponents')
        .insert({ profile_id: pid, name: trimName || `Tracker ${tracker_id}`, club, rating, tracker_id })
        .select()
        .single();
    if (e2) throw e2;
    return created;
}

export async function getSwot(opponentId) {
    const { data, error } = await supa
        .from('opponent_swots')
        .select('*')
        .eq('opponent_id', opponentId)
        .maybeSingle();
    if (error) throw error;
    return data;
}

export async function upsertSwot(opponentId, patch) {
    const pid = activeProfileId();
    const { data, error } = await supa
        .from('opponent_swots')
        .upsert({ opponent_id: opponentId, profile_id: pid, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'opponent_id' })
        .select()
        .single();
    if (error) throw error;
    return data;
}

// 5W2H scout cards
export async function listScoutCards(opponentId) {
    const { data, error } = await supa
        .from('opponent_5w2h')
        .select('*')
        .eq('opponent_id', opponentId)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

// Physical
export async function getPhysicalForDate(date) {
    const pid = activeProfileId();
    const { data, error } = await supa
        .from('physical_sessions')
        .select('*')
        .eq('profile_id', pid)
        .eq('date', date)
        .maybeSingle();
    if (error) throw error;
    return data;
}

export async function listPhysicalRecent(days = 14) {
    const pid = activeProfileId();
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
    const { data, error } = await supa
        .from('physical_sessions')
        .select('*')
        .eq('profile_id', pid)
        .gte('date', cutoff.toISOString().slice(0, 10))
        .order('date', { ascending: false });
    if (error) throw error;
    return data || [];
}

// Mental
export async function getMentalForDate(date) {
    const pid = activeProfileId();
    const { data, error } = await supa
        .from('mental_sessions')
        .select('*')
        .eq('profile_id', pid)
        .eq('date', date)
        .maybeSingle();
    if (error) throw error;
    return data;
}

// Lessons
export async function listPrivateLessons(limit = 30) {
    const pid = activeProfileId();
    const { data, error } = await supa
        .from('private_lessons')
        .select('*')
        .eq('profile_id', pid)
        .is('deleted_at', null)
        .order('date', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

export async function listGroupLessons(limit = 30) {
    const pid = activeProfileId();
    const { data, error } = await supa
        .from('group_lessons')
        .select('*')
        .eq('profile_id', pid)
        .is('deleted_at', null)
        .order('date', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

// Tournaments
export async function listTournaments() {
    const pid = activeProfileId();
    const { data, error } = await supa
        .from('tournaments')
        .select('*')
        .eq('profile_id', pid)
        .is('deleted_at', null)
        .order('start_date');
    if (error) throw error;
    return data || [];
}

export async function nextTournament() {
    const today = new Date().toISOString().slice(0, 10);
    const pid = activeProfileId();
    const { data, error } = await supa
        .from('tournaments')
        .select('*')
        .eq('profile_id', pid)
        .is('deleted_at', null)
        .gte('start_date', today)
        .order('start_date')
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data;
}

// Drill library — categorized exercise catalog (replaces hardcoded plans)
export async function listDrillLibrary() {
    const { data, error } = await supa
        .from('drill_library')
        .select('*')
        .eq('is_archived', false)
        .order('category')
        .order('label');
    if (error) throw error;
    return data || [];
}

export async function addDrillToLibrary({ category, label, default_reps, default_sets, default_rest_s, notes }) {
    const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const { data, error } = await supa
        .from('drill_library')
        .insert({ category, slug, label, default_reps, default_sets, default_rest_s, notes })
        .select()
        .single();
    if (error) throw error;
    return data;
}

// =====================================================
// XP inputs — bulk fetch for the level dashboard
// Returns ALL data for a specific profile (not just current active)
// =====================================================

export async function fetchXpInputs(profileId) {
    if (!profileId) return null;
    const [bouts, physical, mental, lessons_pvt, lessons_grp, swots] = await Promise.all([
        supa.from('bouts').select('id, date, my_score, their_score, outcome, reflection').eq('profile_id', profileId),
        supa.from('physical_sessions').select('date, drills_completed, energy_1_10, soreness_severity, sleep_hours').eq('profile_id', profileId),
        supa.from('mental_sessions').select('date, meditation_duration_min, scenarios_rehearsed').eq('profile_id', profileId),
        supa.from('private_lessons').select('date, topics').eq('profile_id', profileId),
        supa.from('group_lessons').select('date, topics').eq('profile_id', profileId),
        supa.from('opponent_swots').select('strengths, weaknesses, opportunities, threats').eq('profile_id', profileId)
    ]);
    return {
        bouts: bouts.data || [],
        physical_sessions: physical.data || [],
        mental_sessions: mental.data || [],
        private_lessons: lessons_pvt.data || [],
        group_lessons: lessons_grp.data || [],
        opponent_swots: swots.data || []
    };
}

export async function listAllProfiles() {
    const { data, error } = await supa.from('profiles').select('id, name, role, accent_hex').order('role');
    if (error) throw error;
    return data || [];
}
