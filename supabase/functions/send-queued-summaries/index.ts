// Pharma — send-queued-summaries (Supabase Edge Function)
//
// Sends the evening summary messages the database has already queued (kind 'summary',
// status 'queued' in sms_log). Nobody is signed in when this runs: the nightly database
// job (queue_evening_summaries(), in migrations/2026-11-07_evening_summary.sql) queues the
// messages and then nudges this function, through pg_net, with a shared secret instead of a
// person's login. No pharmacy's SMS limit or on/off switch is re-checked here — that already
// happened, as the person's own, when the message was queued.
//
// Uses the exact same sending code as send-sms (sendOne / apiBase / isConfigured in
// ../send-sms/sender.ts), so a message sent this way goes out exactly the same way a
// person's own message does.
//
// Deploy with verify_jwt OFF (pg_net does not send a user login) and set the secret with:
//   supabase secrets set CRON_SHARED_SECRET=<a long random value>
// then store that same value in the database with:
//   select vault.create_secret('<the same value>', 'pharma_cron_shared_secret');
//   select vault.create_secret('<this function''s URL>', 'pharma_cron_sender_url');
// Until both secrets exist, queue_evening_summaries() still queues messages correctly every
// night - it just has nobody to nudge, so they wait until this function is next called.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendOne, isConfigured, type SmsConfig } from "../send-sms/sender.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed." }, 405);

  const want = Deno.env.get("CRON_SHARED_SECRET");
  const got = req.headers.get("x-cron-secret");
  if (!want || !got || got !== want) return json({ ok: false, message: "Not authorized." }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: rows, error } = await admin
    .from("sms_log")
    .select("id, to_phone, body")
    .eq("kind", "summary")
    .eq("status", "queued")
    .order("created_at")
    .limit(200);
  if (error) return json({ ok: false, message: error.message });
  if (!rows || !rows.length) return json({ ok: true, sent: 0, failed: 0 });

  const { data: cfg } = await admin.from("sms_platform_config").select("*").eq("id", 1).maybeSingle();
  let sent = 0, failed = 0;
  if (!isConfigured(cfg as SmsConfig | null)) {
    for (const r of rows) {
      await admin.from("sms_log").update({ status: "failed", error: "SMS is not set up on this server yet." }).eq("id", r.id);
      failed++;
    }
    return json({ ok: true, sent, failed });
  }

  // a few at a time, same as send-sms
  const lane = 5;
  for (let i = 0; i < rows.length; i += lane) {
    const chunk = rows.slice(i, i + lane);
    const got2 = await Promise.all(chunk.map((r) => sendOne(cfg as SmsConfig, { id: r.id, to: r.to_phone, body: r.body }, (u, init) => fetch(u, init))));
    for (const r of got2) {
      if (r.status === "sent") {
        await admin.from("sms_log").update({ status: "sent", provider_id: r.provider_id || null, sent_at: new Date().toISOString(), error: null }).eq("id", r.id);
        sent++;
      } else {
        await admin.from("sms_log").update({ status: "failed", error: r.error || "Delivery failed." }).eq("id", r.id);
        failed++;
      }
    }
  }
  return json({ ok: true, sent, failed });
});
