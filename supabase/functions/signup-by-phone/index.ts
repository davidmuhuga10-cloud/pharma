// Pharma — signup-by-phone
//
// Creates a phone-based account ONLY after the phone number has been proven
// with a code (send-otp -> verify-otp, purpose 'signup'). The caller must
// present the short-lived signed token verify-otp returned. The account is
// created through the admin API (service-role key, never shipped to the
// browser), so the browser's own sb.auth.signUp() is no longer needed — and
// should be switched off in Supabase -> Authentication -> "Allow new users
// to sign up", otherwise anyone could still skip this check by calling
// signUp() directly.
//
// Every expected outcome returns HTTP 200 with ok / error in the body
// (sb.functions.invoke() drops the body of non-2xx replies).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
  return "p" + normalizePhone(phone) + "@hodhi.local"; // same mapping as login — do not change
}

function tokenSecret(): string {
  const secret = Deno.env.get("OTP_TOKEN_SECRET") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new Error("No token secret configured.");
  return secret;
}
async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
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
    if (!timingSafeEqual(new TextEncoder().encode(mac), new TextEncoder().encode(expectedMac))) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(bodyStr)));
    if (payload.purpose !== purpose) return false;
    if (normalizePhone(payload.phone) !== normalizePhone(phone)) return false;
    if (!payload.exp || Date.now() > payload.exp) return false;
    return true;
  } catch (_e) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { phone?: string; password?: string; otp_verified_token?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const phone = normalizePhone(body.phone || "");
  const password = body.password || "";
  if (phone.length !== 12 || phone.slice(0, 3) !== "254") return json({ error: "Enter a correct phone number, e.g. 0712345678." });
  if (password.length < 8) return json({ error: "Use at least 8 characters." });

  const tokenOk = await verifyOtpToken(body.otp_verified_token || "", phone, "signup");
  if (!tokenOk) {
    return json({ error: "Please verify your phone number first (the code may have expired — request a new one)." });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error } = await admin.auth.admin.createUser({
    email: phoneToAuthEmail(phone),
    password,
    email_confirm: true,
  });
  if (error) {
    if (/already|registered|exists/i.test(error.message)) {
      return json({ error: "That phone number is already registered — log in instead.", exists: true });
    }
    return json({ error: "Could not create the account right now. Try again shortly." });
  }
  return json({ ok: true });
});
