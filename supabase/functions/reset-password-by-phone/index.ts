// Pharma — reset a phone-based account's password.
//
// Requires proof of phone ownership first: the caller must have already
// completed send-otp -> verify-otp for purpose 'password_reset' and present
// the resulting short-lived signed otp_verified_token.
//
// Every expected outcome returns HTTP 200 with error:<string>|ok:true in the
// body instead of a non-2xx status — sb.functions.invoke() discards the
// response body on any non-2xx status, so those specific messages ('too many
// attempts', 'no account found', etc.) would never reach the screen. See
// send-otp's file header for the full explanation.
//
// On a successful reset, this sends a best-effort SMS notice to the SAME
// phone number the password was just changed on — the standard
// account-takeover tripwire. It's deliberately fire-and-forget: a delivery
// failure never blocks or fails the reset itself, since the reset already
// succeeded and the caller already proved phone ownership via OTP.
//
// It exists as an Edge Function (not client-side code) for one reason that
// isn't optional: changing another Supabase Auth user's password requires
// the project's service-role key, and that key must never be shipped to the
// browser.
//
// verify_jwt is deliberately OFF — this is the forgot-password flow, called
// by someone who by definition isn't logged in and has no session JWT to
// send. Authorization here comes from the OTP token proven above, not a
// Supabase session.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_ATTEMPTS_PER_HOUR = 3;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function normalizePhone(raw: string): string {
  let digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10 && digits.charAt(0) === "0") digits = "254" + digits.slice(1);
  else if (digits.length === 9) digits = "254" + digits;
  return digits;
}
function phoneToAuthEmail(phone: string): string {
  return "p" + normalizePhone(phone) + "@hodhi.local"; // unchanged on purpose: renaming this domain would orphan every existing login
}
function toE164Phone(normalized: string): string {
  return normalized ? "+" + normalized : "";
}

function tokenSecret(): string {
  const secret = Deno.env.get("OTP_TOKEN_SECRET") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new Error("No token secret configured.");
  return secret;
}
async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function verifyOtpToken(token: string, phone: string, purpose: string): Promise<boolean> {
  try {
    const [bodyStr, mac] = String(token || "").split(".");
    if (!bodyStr || !mac) return false;
    const expectedMac = toBase64Url(await hmacSha256(tokenSecret(), bodyStr));
    const macBytes = new TextEncoder().encode(mac);
    const expectedBytes = new TextEncoder().encode(expectedMac);
    if (!timingSafeEqual(macBytes, expectedBytes)) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(bodyStr)));
    if (payload.purpose !== purpose) return false;
    if (normalizePhone(payload.phone) !== normalizePhone(phone)) return false;
    if (!payload.exp || Date.now() > payload.exp) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// --- SMS notify-on-reset — same sms_platform_config table and Africa's
// Talking call shape as send-otp, duplicated here rather than shared since
// these Edge Functions don't use an import map. Deliberately swallows every
// error: a notification that fails to send must never turn an
// already-successful password reset into an error response.
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
async function sendResetNoticeSms(admin: any, normalizedPhone: string) {
  try {
    const cfg = await loadSmsConfig(admin);
    if (!isConfigured(cfg)) return; // no provider configured — silently skip, same as send-otp's own "not configured" path
    const to = toE164Phone(normalizedPhone);
    if (!to || to.length < 8) return;
    const message = "Your Pharma account password was just changed. If this wasn't you, contact your pharmacy owner immediately.";
    const form = new URLSearchParams();
    form.set("username", cfg.username);
    form.set("to", to);
    form.set("message", message);
    if (cfg.sender_id) form.set("from", cfg.sender_id);
    await fetch(apiBase(cfg) + "/version1/messaging", {
      method: "POST",
      headers: {
        apiKey: cfg.api_key,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
  } catch (e) {
    // Best-effort only — never let a notification failure surface to the caller.
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { phone?: string; newPassword?: string; otp_verified_token?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const phone = (body.phone || "").trim();
  const newPassword = body.newPassword || "";
  if (!phone) return json({ error: "Enter the phone number on the account." });
  if (newPassword.length < 8) return json({ error: "Use at least 8 characters." });

  const tokenOk = await verifyOtpToken(body.otp_verified_token || "", phone, "password_reset");
  if (!tokenOk) {
    return json({ error: "Please verify your phone number first (the code may have expired — request a new one)." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const phoneKey = normalizePhone(phone);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentAttempts, error: countErr } = await admin
    .from("password_reset_attempts")
    .select("id", { count: "exact", head: true })
    .eq("phone_key", phoneKey)
    .gte("attempted_at", oneHourAgo);

  if (countErr) return json({ error: "Could not process that right now. Try again shortly." });
  if ((recentAttempts ?? 0) >= MAX_ATTEMPTS_PER_HOUR) {
    return json({ error: "Too many reset attempts for this phone number. Try again in an hour." });
  }

  await admin.from("password_reset_attempts").insert({ phone_key: phoneKey });

  const targetEmail = phoneToAuthEmail(phone);

  let userId: string | null = null;
  for (let page = 1; page <= 20 && !userId; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return json({ error: "Could not look up that account. Try again shortly." });
    const match = data.users.find((u) => (u.email || "").toLowerCase() === targetEmail);
    if (match) userId = match.id;
    if (data.users.length < 1000) break; // last page
  }

  if (!userId) {
    return json({ error: "No Pharma account is registered with that phone number." });
  }

  const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password: newPassword });
  if (updateErr) return json({ error: updateErr.message });

  // Fire-and-forget — still awaited here (not detached) only because Edge
  // Functions can be frozen right after the response is returned, so a truly
  // un-awaited call risks never actually being sent.
  await sendResetNoticeSms(admin, phoneKey);

  return json({ ok: true });
});
