// Pharma — send-queued-summaries (Supabase Edge Function)
//
// Sends the evening summary messages the database has already queued (kind 'summary',
// status 'queued' in sms_log). Nobody is signed in when this runs: the nightly database job
// (queue_evening_summaries()) queues the messages and nudges this function through pg_net with a
// shared secret instead of a person's login. A second database job (nudge_summary_sender()) nudges
// again every few minutes while anything is still queued.
//
// Changes from v2: drains the whole queue in rounds of 100 inside a time budget (v2 handled at most
// 200 per call, so a night with more queued messages left the rest unsent), compares the secret in
// constant time, and stops instead of looping if a status update fails.
//
// verify_jwt is OFF (pg_net sends no user login); authorization is the x-cron-secret header.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendOne, isConfigured, type SmsConfig } from "./sender.ts";

const ROUND_SIZE = 100;
const LANE = 5;
const BUDGET_MS = 110_000; // stay well inside the edge function wall-clock limit

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed." }, 405);

  const want = Deno.env.get("CRON_SHARED_SECRET");
  const got = req.headers.get("x-cron-secret");
  if (!want || !got || !safeEqual(got, want)) return json({ ok: false, message: "Not authorized." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: cfg } = await admin.from("sms_platform_config").select("*").eq("id", 1).maybeSingle();
  const configured = isConfigured(cfg as SmsConfig | null);

  const started = Date.now();
  let sent = 0, failed = 0, rounds = 0, updateErrors = 0;

  while (Date.now() - started < BUDGET_MS && updateErrors === 0) {
    const { data: rows, error } = await admin
      .from("sms_log")
      .select("id, to_phone, body")
      .eq("kind", "summary")
      .eq("status", "queued")
      .order("created_at")
      .limit(ROUND_SIZE);
    if (error) return json({ ok: false, message: error.message, sent, failed });
    if (!rows || !rows.length) break;
    rounds++;

    if (!configured) {
      for (const r of rows) {
        const { error: e } = await admin.from("sms_log").update({ status: "failed", error: "SMS is not set up on this server yet." }).eq("id", r.id);
        if (e) updateErrors++; else failed++;
      }
      continue;
    }

    for (let i = 0; i < rows.length; i += LANE) {
      const chunk = rows.slice(i, i + LANE);
      const results = await Promise.all(
        chunk.map((r) => sendOne(cfg as SmsConfig, { id: r.id, to: r.to_phone, body: r.body }, (u, init) => fetch(u, init))),
      );
      for (const r of results) {
        const patch = r.status === "sent"
          ? { status: "sent", provider_id: r.provider_id || null, sent_at: new Date().toISOString(), error: null }
          : { status: "failed", error: r.error || "Delivery failed." };
        const { error: e } = await admin.from("sms_log").update(patch).eq("id", r.id);
        if (e) updateErrors++;
        else if (r.status === "sent") sent++;
        else failed++;
      }
    }
  }

  const { count: remaining } = await admin
    .from("sms_log").select("id", { count: "exact", head: true }).eq("kind", "summary").eq("status", "queued");
  return json({ ok: updateErrors === 0, sent, failed, rounds, remaining: remaining ?? null, update_errors: updateErrors });
});
