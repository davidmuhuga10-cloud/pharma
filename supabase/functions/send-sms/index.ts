// Pharma — send-sms (Supabase Edge Function)
//
// Sends SMS for the signed-in pharmacy (refill reminders, credit reminders,
// custom messages). See sender.ts for how a request is handled. Provider
// credentials stay in the sms_platform_config table, readable only with the
// service role, never by the browser.
//
// Deploy with verify_jwt on: only signed-in users reach it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handle } from "./sender.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed." }, 405);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, message: "Invalid request." }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") || "";
  if (!auth) return json({ ok: false, message: "Please sign in again." });

  // as the user: the database decides who may send and how many
  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // as the server: provider credentials and marking log rows sent or failed
  const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const out = await handle(body, {
      queue: (pharmacyId, messages) =>
        asUser.rpc("sms_queue", { p_pharmacy_id: pharmacyId, p_messages: messages }) as any,
      loadConfig: async () => {
        const { data } = await admin.from("sms_platform_config").select("*").eq("id", 1).maybeSingle();
        return data || null;
      },
      mark: async (id, patch) => {
        await admin.from("sms_log").update(patch).eq("id", id);
        // A refill reminder that failed to send should not count as "reminded
        // today", or the person could not try again until tomorrow.
        if (patch.status === "failed") {
          const { data: row } = await admin.from("sms_log").select("kind, ref_id").eq("id", id).maybeSingle();
          if (row && row.kind === "refill" && row.ref_id) {
            await admin.from("refill_plans").update({ last_reminded_on: null }).eq("id", row.ref_id);
          }
        }
      },
      fetchFn: (u, init) => fetch(u, init),
      now: () => new Date().toISOString(),
    });
    return json(out);
  } catch (_e) {
    return json({ ok: false, message: "Could not send right now. Try again shortly." });
  }
});
