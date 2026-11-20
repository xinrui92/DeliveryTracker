// Admin user management for Delivery Tracker.
// Only active admins can call this. Uses the service role key (available automatically in Supabase Edge Functions).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ROLES = ["admin", "editor", "viewer"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Identify caller
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);
  const callerId = userData.user.id;

  const { data: caller } = await admin.from("profiles").select("role,is_active").eq("id", callerId).single();
  if (!caller || caller.role !== "admin" || !caller.is_active) return json({ error: "Admins only" }, 403);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { action } = body;

  try {
    switch (action) {
      case "list": {
        const { data: profiles, error } = await admin.from("profiles").select("*").order("created_at");
        if (error) throw error;
        // add last sign-in from auth
        const { data: authList } = await admin.auth.admin.listUsers({ perPage: 1000 });
        const lastSignIn = new Map((authList?.users || []).map((u) => [u.id, u.last_sign_in_at]));
        return json({ users: profiles.map((p) => ({ ...p, last_sign_in_at: lastSignIn.get(p.id) || null })) });
      }

      case "create": {
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        const role = ROLES.includes(body.role) ? body.role : "viewer";
        if (!email || !email.includes("@")) return json({ error: "Valid email required" }, 400);
        if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
        const { data, error } = await admin.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { full_name: body.full_name || null },
          app_metadata: { role, active: true },
        });
        if (error) throw error;
        // make sure profile reflects choice (trigger already creates it)
        await admin.from("profiles").update({ role, is_active: true, full_name: body.full_name || null }).eq("id", data.user.id);
        return json({ ok: true, id: data.user.id });
      }

      case "update": {
        const id = String(body.id || "");
        if (!id) return json({ error: "id required" }, 400);
        const patch: Record<string, unknown> = {};
        if (body.role !== undefined) {
          if (!ROLES.includes(body.role)) return json({ error: "Invalid role" }, 400);
          patch.role = body.role;
        }
        if (body.is_active !== undefined) patch.is_active = !!body.is_active;
        if (body.full_name !== undefined) patch.full_name = body.full_name;

        // don't let the last active admin lock themselves out
        if (id === callerId && (patch.role && patch.role !== "admin" || patch.is_active === false)) {
          const { count } = await admin.from("profiles").select("id", { count: "exact", head: true })
            .eq("role", "admin").eq("is_active", true);
          if ((count || 0) <= 1) return json({ error: "You are the only active admin. Make someone else admin first." }, 400);
        }

        const { error } = await admin.from("profiles").update(patch).eq("id", id);
        if (error) throw error;
        // block / unblock sign-in at the auth level too
        if (patch.is_active !== undefined) {
          await admin.auth.admin.updateUserById(id, { ban_duration: patch.is_active ? "none" : "876000h" });
        }
        return json({ ok: true });
      }

      case "reset_password": {
        const id = String(body.id || "");
        const password = String(body.password || "");
        if (!id || password.length < 8) return json({ error: "id and a password of 8+ characters required" }, 400);
        const { error } = await admin.auth.admin.updateUserById(id, { password });
        if (error) throw error;
        return json({ ok: true });
      }

      case "delete": {
        const id = String(body.id || "");
        if (!id) return json({ error: "id required" }, 400);
        if (id === callerId) return json({ error: "You can't delete your own account" }, 400);
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) throw error;
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 400);
  }
});
