// En Garde — Claude coaching Edge Function
// One Edge Function, three actions:
//   action: 'bout-debrief'      → debrief a single bout (post-fencing analysis)
//   action: 'today-coach-card'  → today's focus + warm-up + one drill
//   action: 'opponent-profiler' → analyze a priority opponent

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_DEFAULT = 'claude-sonnet-4-6';
const MODEL_FAST    = 'claude-haiku-4-5-20251001';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return jsonResp({ error: 'POST only' }, 405);

    let body: any;
    try { body = await req.json(); }
    catch { return jsonResp({ error: 'invalid JSON body' }, 400); }

    const { action, profile_id } = body || {};
    if (!action || !profile_id) return jsonResp({ error: 'missing action or profile_id' }, 400);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResp({ error: 'missing Authorization' }, 401);

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!ANTHROPIC_KEY) return jsonResp({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

    const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } }
    });
    // The gateway only checks that the token is signed; the public anon key
    // passes that. So: a real user, a member, the owner of this profile, and
    // no more than 20 coaching calls per profile per day, before any
    // Anthropic spend.
    const { data: who } = await supa.auth.getUser();
    if (!who?.user) return jsonResp({ error: 'sign in first' }, 401);
    const { data: mine } = await supa.rpc('profile_belongs_to_me', { p_profile_id: profile_id });
    if (!mine) return jsonResp({ error: 'not your fencer' }, 403);
    const since = new Date(Date.now() - 864e5).toISOString();
    const { count } = await supa.from('coach_notes').select('id', { count: 'exact', head: true }).eq('profile_id', profile_id).gte('created_at', since);
    if ((count || 0) >= 20) return jsonResp({ error: 'daily coaching limit reached; try tomorrow' }, 429);

    try {
        let result: { text: string; promptSummary: any; model: string };

        if (action === 'bout-debrief') {
            result = await runBoutDebrief(supa, body, ANTHROPIC_KEY);
        } else if (action === 'today-coach-card') {
            result = await runTodayCoachCard(supa, body, ANTHROPIC_KEY);
        } else if (action === 'opponent-profiler') {
            result = await runOpponentProfiler(supa, body, ANTHROPIC_KEY);
        } else {
            return jsonResp({ error: `unknown action: ${action}` }, 400);
        }

        const { data: saved, error: saveErr } = await supa
            .from('coach_notes')
            .insert({
                profile_id,
                bout_id: body.bout_id || null,
                opponent_id: body.opponent_id || null,
                kind: action,
                input_summary: result.promptSummary,
                model: result.model,
                response_text: result.text
            })
            .select()
            .single();

        if (saveErr) console.error('coach_notes save failed', saveErr);

        return jsonResp({
            ok: true,
            note_id: saved?.id || null,
            text: result.text,
            model: result.model
        });
    } catch (err: any) {
        console.error('claude-coach error', err);
        return jsonResp({ error: err?.message || String(err) }, 500);
    }
});

async function runBoutDebrief(supa: any, body: any, key: string) {
    const { profile_id, bout_id } = body;
    if (!bout_id) throw new Error('bout-debrief requires bout_id');

    const [{ data: bout }, { data: profile }, { data: ctx }] = await Promise.all([
        supa.from('bouts').select('*').eq('id', bout_id).single(),
        supa.from('profiles').select('id, name, role, primary_weapon').eq('id', profile_id).single(),
        supa.from('profile_context').select('kind, content').eq('profile_id', profile_id)
    ]);

    let opp: any = null;
    if (bout?.opponent_id) {
        const r = await supa.from('opponents').select('*').eq('id', bout.opponent_id).single();
        opp = r.data;
    }

    const promptSummary = {
        bout: pickBout(bout),
        opponent: opp ? pickOpponent(opp) : null,
        profile: profile ? { name: profile.name, role: profile.role } : null,
        context_kinds: (ctx || []).map((c: any) => c.kind)
    };

    const system = `You are the Tsui family fencing coach. The fencer just finished a bout. Give a tight, useful debrief. Stay direct. No fluff. No emojis.

Format your response as 3 short sections, separated by blank lines:

WHAT HAPPENED — one or two sentences naming what worked and what didn't, in plain language.

ROOT CAUSE — one sentence. The single underlying pattern (timing? distance? blade-work? mental?). Pick one.

NEXT TRAINING TOUCH — one concrete drill or focus point for the very next training session, two sentences max.

Use the fencer's first name. If you're missing data, say so plainly — don't invent.`;

    const userMsg = JSON.stringify({
        profile: profile ? { name: profile.name, role: profile.role, weapon: profile.primary_weapon } : null,
        bout: pickBout(bout),
        opponent: opp ? pickOpponent(opp) : null,
        long_term_context: (ctx || []).map((c: any) => ({ kind: c.kind, content: c.content }))
    }, null, 2);

    const text = await callClaude({ key, model: MODEL_DEFAULT, system: system, userMessage: userMsg, maxTokens: 700 });
    return { text, promptSummary, model: MODEL_DEFAULT };
}

async function runTodayCoachCard(supa: any, body: any, key: string) {
    const { profile_id } = body;

    const [{ data: profile }, { data: ctx }, { data: recent }] = await Promise.all([
        supa.from('profiles').select('id, name, role, primary_weapon').eq('id', profile_id).single(),
        supa.from('profile_context').select('kind, content').eq('profile_id', profile_id),
        supa.from('bouts')
            .select('date, outcome, my_score, their_score, location, failure_patterns')
            .eq('profile_id', profile_id)
            .order('date', { ascending: false })
            .limit(8)
    ]);

    const today = new Date().toISOString().slice(0, 10);

    const promptSummary = {
        today,
        profile: profile ? { name: profile.name, role: profile.role } : null,
        recent_bouts_count: recent?.length || 0,
        context_kinds: (ctx || []).map((c: any) => c.kind)
    };

    const system = `You are the Tsui family fencing coach. Generate today's coaching card for ${profile?.name || 'the fencer'}. Three short paragraphs:

FOCUS OF THE DAY — one Foil-IQ idea, not a technical drill. Tied to the fencer's recent pattern.

WARM-UP CUE — one specific thing to feel during footwork warm-up. One sentence.

ONE DRILL — name the drill, the rep count, and the one cue word the fencer should hold in their head.

Stay direct. Use their first name. Tie to their long-term context if relevant. No emojis. No bullet points.`;

    const userMsg = JSON.stringify({
        today,
        profile,
        long_term_context: (ctx || []).map((c: any) => ({ kind: c.kind, content: c.content })),
        recent_bouts: recent || []
    }, null, 2);

    const text = await callClaude({ key, model: MODEL_FAST, system: system, userMessage: userMsg, maxTokens: 500 });
    return { text, promptSummary, model: MODEL_FAST };
}

async function runOpponentProfiler(supa: any, body: any, key: string) {
    const { profile_id, opponent_id } = body;
    if (!opponent_id) throw new Error('opponent-profiler requires opponent_id');

    const [{ data: opp }, { data: profile }, { data: ctx }, { data: history }] = await Promise.all([
        supa.from('opponents').select('*').eq('id', opponent_id).single(),
        supa.from('profiles').select('id, name, role').eq('id', profile_id).single(),
        supa.from('profile_context').select('kind, content').eq('profile_id', profile_id),
        supa.from('bouts')
            .select('date, outcome, my_score, their_score, failure_patterns, scoring_actions')
            .eq('opponent_id', opponent_id)
            .order('date', { ascending: false })
            .limit(20)
    ]);

    const promptSummary = {
        opponent: pickOpponent(opp),
        bout_history_count: history?.length || 0,
        profile: profile ? { name: profile.name, role: profile.role } : null
    };

    const system = `You are the Tsui family fencing coach analyzing a priority opponent. The fencer needs a starter style-profile and an opening-touch plan.

Return your analysis as plain prose under three short headings:

STYLE READ — one paragraph: tempo, distance, hand, what they like to do.

WHAT WILL HIT THEM — two sentences: which actions in the fencer's toolbox should land. Be specific.

OPENING TOUCH PLAN — three sentences: what to do in the first 30 seconds of the bout to test their reaction.

Be honest about confidence — if the bout history is thin, say so. Use the fencer's first name. No emojis.`;

    const userMsg = JSON.stringify({
        opponent: pickOpponent(opp),
        full_opponent_record: opp,
        profile,
        long_term_context: (ctx || []).map((c: any) => ({ kind: c.kind, content: c.content })),
        bout_history: history || []
    }, null, 2);

    const text = await callClaude({ key, model: MODEL_DEFAULT, system: system, userMessage: userMsg, maxTokens: 700 });
    return { text, promptSummary, model: MODEL_DEFAULT };
}

async function callClaude(opts: { key: string; model: string; system: string; userMessage: string; maxTokens: number; }) {
    const r = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': opts.key,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: opts.model,
            max_tokens: opts.maxTokens,
            system: opts.system,
            messages: [{ role: 'user', content: opts.userMessage }]
        })
    });

    if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Anthropic ${r.status}: ${errText.slice(0, 500)}`);
    }
    const data = await r.json();
    const text = (data.content || [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
    if (!text) throw new Error('Anthropic returned no text');
    return text;
}

function pickBout(b: any) {
    if (!b) return null;
    return {
        date: b.date,
        location: b.location,
        outcome: b.outcome,
        my_score: b.my_score,
        their_score: b.their_score,
        scoring_actions: b.scoring_actions,
        failure_patterns: b.failure_patterns,
        notes: b.notes
    };
}

function pickOpponent(o: any) {
    if (!o) return null;
    return {
        name: o.name,
        club: o.club,
        rating: o.rating,
        hand: o.hand,
        archetypes: o.archetypes,
        is_priority_target: o.is_priority_target,
        style_profile: o.style_profile
    };
}

function jsonResp(obj: any, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
                                               }
