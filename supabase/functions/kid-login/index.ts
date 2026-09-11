// kid-login — a parent gives one of the family's fencers a login of his own.
// The parent's session proves who is asking; the profile must belong to that
// parent; the new auth user is created with the service key and attached to
// the profile as login_user_id, which is what makes the kid see only himself.

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
  const profileId = String(body.profile_id || "");
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!profileId || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 8) return json({ error: "profile, a valid email and a password of 8 or more" }, 400);

  // The profile must be the caller's own fencer (RLS on the caller's client).
  const { data: prof } = await anon.from("profiles").select("id,name,kind,owner_user_id,login_user_id").eq("id", profileId).maybeSingle();
  if (!prof || prof.owner_user_id !== who.user.id) return json({ error: "not your fencer" }, 403);
  if (prof.kind !== "fencer") return json({ error: "logins are for fencers" }, 400);
  if (prof.login_user_id) return json({ error: `${prof.name} already has a login` }, 409);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { profile_id: profileId, created_by: who.user.id } });
  if (error) return json({ error: error.message }, 400);
  const { error: e2 } = await admin.from("profiles").update({ login_user_id: created.user.id }).eq("id", profileId);
  if (e2) return json({ error: e2.message }, 500);
  return json({ ok: true, email, profile_id: profileId });
});
