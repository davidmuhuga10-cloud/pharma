// Pharma — verify-otp
//
// Second half of phone verification (see send-otp). Checks a submitted
// 6-digit code against the latest unconsumed phone_otps row for that
// phone+purpose and, on a match, returns a short-lived signed token proving
// THIS phone was just verified for THIS purpose. reset-password-by-phone and
// signup-by-phone each require that token. This endpoint never touches an
// account itself.
//
// Every expected outcome returns HTTP 200 with ok:false (see send-otp).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PURPOSES = ["password_reset", "signup"];
const MAX_ATTEMPTS = 5;
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes to actually use a verified token

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

async function hashCode(phone: string, purpose: string, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${normalizePhone(phone)}|${purpose}|${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tokenSecret(): string {
  const secret = Deno.env.get("OTP_TOKEN_SECRET") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new Error("No token secret configured.");
  return secret;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

async function signVerifiedToken(phone: string, purpose: string): Promise<string> {
  const payload = { phone: normalizePhone(phone), purpose, exp: Date.now() + TOKEN_TTL_MS };
  const bodyStr = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = toBase64Url(await hmacSha256(tokenSecret(), bodyStr));
  return `${bodyStr}.${mac}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed." }, 405);

  let body: { phone?: string; purpose?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, message: "Invalid request body." }, 400);
  }

  const phone = normalizePhone(body.phone || "");
  const purpose = String(body.purpose || "").trim();
  const code = String(body.code || "").trim();

  if (!phone) return json({ ok: false, message: "Missing phone number." });
  if (PURPOSES.indexOf(purpose) === -1) return json({ ok: false, message: "Unknown verification purpose." });
  if (!/^\d{6}$/.test(code)) return json({ ok: false, message: "Enter the 6-digit code." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // The database checks the code and counts a miss in ONE locked step
  // (otp_check). Doing it as "read the row, then write attempts + 1" here let
  // many guesses sent at the same instant all count as the first attempt and
  // slip past the 5-guess limit.
  const expectedHash = await hashCode(phone, purpose, code);
  const { data: res, error: checkErr } = await admin.rpc("otp_check", {
    p_phone: phone,
    p_purpose: purpose,
    p_code_hash: expectedHash,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (checkErr || !res) return json({ ok: false, message: "Could not verify that code right now. Try again shortly." });

  if (res.status === "none") return json({ ok: false, message: "No code was requested for this number — request a new one." });
  if (res.status === "expired") return json({ ok: false, message: "That code has expired — request a new one." });
  if (res.status === "locked") return json({ ok: false, message: "Too many incorrect attempts — request a new code." });
  if (res.status === "wrong") {
    const left = Number(res.left) || 0;
    return json({
      ok: false,
      message: left > 0 ? `Incorrect code — ${left} attempt(s) left.` : "Incorrect code — request a new one.",
    });
  }
  if (res.status !== "ok") return json({ ok: false, message: "Could not verify that code right now. Try again shortly." });

  const token = await signVerifiedToken(phone, purpose);
  return json({ ok: true, verified_token: token });
});
