// kid-login — a parent manages the logins of the family's fencers.
// The parent's session proves who is asking; the profile must belong to that
// parent; auth users are touched with the service key.
//
//   { profile_id, email, password }            create a login and attach it as
//                                              profiles.login_user_id (the kid
//                                              then sees only himself).
//   { mode: "reset", profile_id, password }    set a new password on an existing
//                                              login (the parent forgot it).
//   { mode: "who" }                            which email each of the caller's
//                                              fencers signs in with.

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const auth = req.headers.get("Authorization") || "";
  const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: who } = await anon.auth.getUser();
  if (!who?.user) return json({ error: "sign in first" }, 401);
  const { data: parent } = await anon.rpc("is_parent");
  if (!parent) return json({ error: "parents only" }, 403);

  const body = await req.json().catch(() => ({}));
  const mode = String(body.mode || "create");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Which address each fencer signs in with. Only the caller's own fencers
  // (RLS on the caller's client), only the email, never anything secret.
  if (mode === "who") {
    const { data: profs } = await anon.from("profiles").select("id,name,login_user_id").eq("kind", "fencer").not("login_user_id", "is", null);
    const logins: Record<string, { email: string | null; last_sign_in_at: string | null }> = {};
    for (const p of profs || []) {
      const { data } = await admin.auth.admin.getUserById(p.login_user_id);
      logins[p.id] = { email: data?.user?.email || null, last_sign_in_at: data?.user?.last_sign_in_at || null };
    }
    return json({ logins });
  }

  const profileId = String(body.profile_id || "");
  const password = String(body.password || "");
  if (!profileId || password.length < 8) return json({ error: "profile and a password of 8 or more" }, 400);

  // The profile must be the caller's own fencer (RLS on the caller's client).
  const { data: prof } = await anon.from("profiles").select("id,name,kind,owner_user_id,login_user_id").eq("id", profileId).maybeSingle();
  if (!prof || prof.owner_user_id !== who.user.id) return json({ error: "not your fencer" }, 403);
  if (prof.kind !== "fencer") return json({ error: "logins are for fencers" }, 400);

  // A new password for a login that already exists.
  if (mode === "reset") {
    if (!prof.login_user_id) return json({ error: `${prof.name} has no login yet` }, 409);
    const { data, error } = await admin.auth.admin.updateUserById(prof.login_user_id, { password });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, email: data.user?.email || null, profile_id: profileId });
  }

  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "a valid email is needed" }, 400);
  if (prof.login_user_id) return json({ error: `${prof.name} already has a login` }, 409);
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { profile_id: profileId, created_by: who.user.id } });
  if (error) return json({ error: error.message }, 400);
  const { error: e2 } = await admin.from("profiles").update({ login_user_id: created.user.id }).eq("id", profileId);
  if (e2) return json({ error: e2.message }, 500);
  return json({ ok: true, email, profile_id: profileId });
});
