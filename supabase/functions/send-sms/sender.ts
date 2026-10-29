// Pharma — send-sms: the part that can be tested without Deno or a network.
//
// The browser calls the send-sms Edge Function with the messages it wants sent.
// The function first asks the database (as the signed-in user) to approve and
// log them with sms_queue(): that is where the role check, the daily limit,
// opt-outs and "already reminded today" live. Only messages the database
// queued are sent, and each log row is then marked sent or failed.
//
// Every outcome returns HTTP 200 with ok true/false in the body: supabase-js
// throws the body away on a non-2xx status, so the screen could never show the
// reason. (Same rule as send-otp.)

export type SmsConfig = { username?: string | null; api_key?: string | null; sender_id?: string | null };
export type Queued = { id: string; to: string; body: string };
export type SendResult = { id: string; status: "sent" | "failed"; provider_id?: string | null; error?: string | null };

export type Deps = {
  // calls sms_queue(p_pharmacy_id, p_messages) as the signed-in user
  queue: (pharmacyId: string, messages: unknown[]) => Promise<{ data: any; error: { message: string } | null }>;
  loadConfig: () => Promise<SmsConfig | null>;
  // marks one log row (service role)
  mark: (id: string, patch: Record<string, unknown>) => Promise<void>;
  fetchFn: (url: string, init: any) => Promise<{ json: () => Promise<any> }>;
  now: () => string;
};

export function isConfigured(cfg: SmsConfig | null | undefined): boolean {
  return !!(cfg && cfg.api_key && cfg.username);
}

export function apiBase(cfg: SmsConfig): string {
  return String(cfg.username).toLowerCase() === "sandbox"
    ? "https://api.sandbox.africastalking.com"
    : "https://api.africastalking.com";
}

const AT_STATUS_LABELS: Record<string, string> = {
  InvalidPhoneNumber: "This phone number is invalid.",
  InsufficientBalance: "The SMS provider account is out of balance.",
  InvalidSenderId: "The sender ID is not approved.",
  UserInBlacklist: "This number has opted out of messages.",
  CouldNotRoute: "Could not be delivered to this network.",
};

export function friendlyDeliveryText(status: string | null | undefined): string {
  if (status && AT_STATUS_LABELS[status]) return AT_STATUS_LABELS[status];
  return status ? `Delivery failed (${status}).` : "Delivery failed.";
}

export async function sendOne(cfg: SmsConfig, q: Queued, fetchFn: Deps["fetchFn"]): Promise<SendResult> {
  const to = "+" + String(q.to || "").replace(/\D/g, "");
  if (to.length < 9) return { id: q.id, status: "failed", error: "No usable phone number on file." };
  const form = new URLSearchParams();
  form.set("username", String(cfg.username));
  form.set("to", to);
  form.set("message", q.body);
  if (cfg.sender_id) form.set("from", String(cfg.sender_id));
  try {
    const res = await fetchFn(apiBase(cfg) + "/version1/messaging", {
      method: "POST",
      headers: {
        apiKey: String(cfg.api_key),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const j = await res.json().catch(() => null);
    const r = j && j.SMSMessageData && j.SMSMessageData.Recipients && j.SMSMessageData.Recipients[0];
    const ok = !!r && String(r.status).toLowerCase() === "success";
    if (ok) return { id: q.id, status: "sent", provider_id: r.messageId || null };
    return { id: q.id, status: "failed", error: friendlyDeliveryText(r ? r.status : null) };
  } catch (_e) {
    return { id: q.id, status: "failed", error: "Could not reach the SMS provider. Try again." };
  }
}

export async function handle(body: any, deps: Deps) {
  const pharmacyId = body && typeof body.pharmacy_id === "string" ? body.pharmacy_id : "";
  const messages = body && Array.isArray(body.messages) ? body.messages : [];
  if (!pharmacyId || !messages.length) return { ok: false, message: "There is nothing to send." };

  const { data, error } = await deps.queue(pharmacyId, messages);
  if (error) return { ok: false, message: error.message };

  const queued: Queued[] = (data && data.queued) || [];
  const skipped = (data && data.skipped) || [];
  const meta = { skipped, used_today: data ? data.used_today : null, daily_cap: data ? data.daily_cap : null };
  if (!queued.length) return { ok: true, sent: 0, failed: 0, results: [], ...meta };

  const cfg = await deps.loadConfig();
  const results: SendResult[] = [];
  if (!isConfigured(cfg)) {
    for (const q of queued) results.push({ id: q.id, status: "failed", error: "SMS is not set up on this server yet." });
  } else {
    // a few at a time: 50 messages one after another could take a while
    const lane = 5;
    for (let i = 0; i < queued.length; i += lane) {
      const chunk = queued.slice(i, i + lane);
      const got = await Promise.all(chunk.map((q) => sendOne(cfg as SmsConfig, q, deps.fetchFn)));
      results.push(...got);
    }
  }

  for (const r of results) {
    await deps.mark(r.id, r.status === "sent"
      ? { status: "sent", provider_id: r.provider_id || null, sent_at: deps.now(), error: null }
      : { status: "failed", error: r.error || "Delivery failed." });
  }
  const sent = results.filter((r) => r.status === "sent").length;
  return { ok: true, sent, failed: results.length - sent, results, ...meta };
}
