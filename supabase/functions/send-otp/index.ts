// Pharma — send-otp
//
// Sends a 6-digit SMS code to a phone number and records only its hash, as
// the first half of proving phone ownership. Purposes: 'password_reset'
// (see reset-password-by-phone) and 'signup' (see signup-by-phone). See
// verify-otp for the second half.
//
// Every "expected" outcome returns HTTP 200 with ok:false in the body, never
// a non-2xx status: sb.functions.invoke() discards the body of non-2xx
// replies, so the caller could never show the real message.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PURPOSES = ["password_reset", "signup"];
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes to enter the code
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const WINDOW_MS = 15 * 60 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Must exactly match normalizePhone() in the app / reset-password-by-phone.
function normalizePhone(raw: string): string {
  let digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10 && digits.charAt(0) === "0") digits = "254" + digits.slice(1);
  else if (digits.length === 9) digits = "254" + digits;
  return digits;
}
function toE164Phone(normalized: string): string {
  return normalized ? "+" + normalized : "";
}
// The login address every phone account uses - same mapping as the app, signup-by-phone
// and reset-password-by-phone. Unchanged on purpose: renaming the domain would orphan every login.
function phoneToAuthEmail(normalized: string): string {
  return "p" + normalized + "@hodhi.local";
}
// The caller's address as seen by Supabase's edge, used only for the per-address limit.
function callerIp(req: Request): string | null {
  const direct = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip");
  if (direct) return direct.trim();
  const chain = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return chain.length ? chain[chain.length - 1] : null; // last entry is the one our own proxy added
}
function envInt(name: string, fallback: number): number {
  const n = parseInt(Deno.env.get(name) || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function generateCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, "0");
}

async function hashCode(phone: string, purpose: string, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${normalizePhone(phone)}|${purpose}|${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// sms_platform_config — single row, server-only (RLS enabled, zero policies).
async function loadSmsConfig(admin: any) {
  try {
    const { data, error } = await admin.from("sms_platform_config").select("*").eq("id", 1).maybeSingle();
    if (error || !data) return {};
    return data;
  } catch (e) {
    return {};
  }
}
function isConfigured(cfg: any) {
  return !!(cfg && cfg.api_key && cfg.username);
}
function apiBase(cfg: any) {
  return String(cfg.username).toLowerCase() === "sandbox"
    ? "https://api.sandbox.africastalking.com"
    : "https://api.africastalking.com";
}

const AT_STATUS_LABELS: Record<string, string> = {
  Success: "Delivered successfully.",
  InvalidPhoneNumber: "This phone number is invalid.",
  InsufficientBalance: "The SMS provider account is out of balance.",
  InvalidSenderId: "The sender ID is not approved.",
  UserInBlacklist: "This number has opted out of messages.",
  CouldNotRoute: "Could not be delivered to this network.",
};
function friendlyDeliveryText(status: string | null): string {
  if (status && AT_STATUS_LABELS[status]) return AT_STATUS_LABELS[status];
  return status ? `Delivery failed (${status}).` : "Delivery failed.";
}

async function sendSms(cfg: any, normalizedPhone: string, message: string) {
  const to = toE164Phone(normalizedPhone);
  if (!to || to.length < 8) return { status: "failed", raw: "No usable phone number on file." };
  const form = new URLSearchParams();
  form.set("username", cfg.username);
  form.set("to", to);
  form.set("message", message);
  if (cfg.sender_id) form.set("from", cfg.sender_id);
  try {
    const res = await fetch(apiBase(cfg) + "/version1/messaging", {
      method: "POST",
      headers: {
        apiKey: cfg.api_key,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const resJson = await res.json().catch(() => null);
    const recipients = (resJson && resJson.SMSMessageData && resJson.SMSMessageData.Recipients) || [];
    const r = recipients[0];
    const success = r && String(r.status).toLowerCase() === "success";
    return { status: success ? "sent" : "failed", raw: friendlyDeliveryText(r ? r.status : null) };
  } catch (e) {
    return { status: "failed", raw: "Could not reach the SMS provider — try resending." };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed." }, 405);

  let body: { phone?: string; purpose?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, message: "Invalid request body." }, 400);
  }

  const phone = normalizePhone(body.phone || "");
  const purpose = String(body.purpose || "").trim();
  if (!phone || phone.length !== 12 || phone.slice(0, 3) !== "254") {
    return json({ ok: false, message: "Enter a correct phone number, e.g. 0712345678." });
  }
  if (PURPOSES.indexOf(purpose) === -1) return json({ ok: false, message: "Unknown verification purpose." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Do not spend an SMS on a number that cannot use the code: a reset code
  // only makes sense for a registered number, a sign-up code only for a free
  // one. Without this check anyone could make the platform pay for texts to
  // any Kenyan number ("SMS pumping").
  const { data: existingId, error: lookupErr } = await admin.rpc("auth_user_id_for_email", { p_email: phoneToAuthEmail(phone) });
  if (lookupErr) return json({ ok: false, message: "Could not send a code right now. Try again shortly." });
  if (purpose === "password_reset" && !existingId) {
    return json({ ok: false, message: "No Pharma account is registered with that phone number." });
  }
  if (purpose === "signup" && existingId) {
    return json({ ok: false, message: "That phone number is already registered — log in instead." });
  }

  // All limits live in the database (otp_issue) and are checked and recorded
  // in one locked step, so requests sent at the same instant cannot slip past:
  // resend cooldown, codes per number, codes per caller address, and a
  // platform-wide ceiling per hour.
  const code = generateCode();
  const codeHash = await hashCode(phone, purpose, code);
  const ip = callerIp(req);
  const { data: issued, error: issueErr } = await admin.rpc("otp_issue", {
    p_phone: phone,
    p_purpose: purpose,
    p_code_hash: codeHash,
    p_ip: ip,
    p_ttl_seconds: Math.round(CODE_TTL_MS / 1000),
    p_cooldown_seconds: Math.round(RESEND_COOLDOWN_MS / 1000),
    p_phone_max: MAX_SENDS_PER_WINDOW,
    p_phone_window_seconds: Math.round(WINDOW_MS / 1000),
    p_ip_max: envInt("OTP_IP_MAX_PER_HOUR", 10),
    p_global_max: envInt("OTP_GLOBAL_MAX_PER_HOUR", 300),
  });
  if (issueErr || !issued) return json({ ok: false, message: "Could not send a code right now. Try again shortly." });
  if (!issued.ok) {
    if (issued.reason === "cooldown") {
      return json({ ok: false, message: `Please wait ${issued.wait_seconds}s before requesting another code.` });
    }
    if (issued.reason === "phone_limit") {
      return json({ ok: false, message: "Too many codes requested for this number — please try again later." });
    }
    return json({ ok: false, message: "Too many code requests right now — please try again in a little while." });
  }

  const smsConfig = await loadSmsConfig(admin);
  if (!isConfigured(smsConfig)) {
    return json({ ok: true, sent: false, message: "SMS provider is not configured — no code was actually sent." });
  }

  const message = `Your Pharma verification code is ${code}. It expires in 5 minutes. Do not share this code.`;
  const result = await sendSms(smsConfig, phone, message);
  if (result.status !== "sent") {
    return json({ ok: true, sent: false, message: `Could not deliver the code: ${result.raw}` });
  }
  return json({ ok: true, sent: true });
});
