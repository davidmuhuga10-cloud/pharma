// Pharma — SMS sending helpers for send-queued-summaries (Africa's Talking).
// Same behaviour as send-sms/sender.ts's sendOne(); kept as a local copy so this function
// deploys on its own (no relative import outside its folder).
export type SmsConfig = { username?: string | null; api_key?: string | null; sender_id?: string | null };
export type Queued = { id: string; to: string; body: string };
export type SendResult = { id: string; status: "sent" | "failed"; provider_id?: string | null; error?: string | null };
type FetchFn = (url: string, init: any) => Promise<{ json: () => Promise<any> }>;

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

export async function sendOne(cfg: SmsConfig, q: Queued, fetchFn: FetchFn): Promise<SendResult> {
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
