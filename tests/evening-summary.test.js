// The evening summary SMS: the Settings card in Messages, and the two edge-function wiring
// points (send-sms's evening_summary mode, and the new send-queued-summaries cron function).
// The message text and the queueing rules are tested in tests/run_tests.js (section "The
// evening summary SMS"). Run from the project folder:   node tests/evening-summary.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const cust = read('js/customers.js'), sender = read('supabase/functions/send-sms/sender.ts');
const idx = read('supabase/functions/send-sms/index.ts'), cronFn = read('supabase/functions/send-queued-summaries/index.ts');
const mig = read('migrations/2026-11-07_evening_summary.sql'), schema = read('schema.sql');

const ctx = { console, esc: s => String(s), showPhone: p => String(p || ''), STATE: { profile: { role: 'owner' }, pharmacy: {} }, $: () => null };
vm.createContext(ctx); vm.runInContext(cust, ctx);

// a non-owner sees nothing when it is off, something when it is on
check(ctx.eveningSummaryHtml.call ? true : true, 'sanity');
ctx.STATE.profile.role = 'attendant';
ctx.STATE.pharmacy = { evening_summary_enabled: false };
check(ctx.eveningSummaryHtml() === '', 'a seller sees nothing about the evening summary while it is off');
ctx.STATE.pharmacy = { evening_summary_enabled: true, evening_summary_phone: '254712345678' };
check(/Only the owner can change this/.test(ctx.eveningSummaryHtml()) && !/<input/.test(ctx.eveningSummaryHtml()), 'a seller sees it is on, with no fields to change it');

// the owner's view
ctx.STATE.profile.role = 'owner';
ctx.STATE.pharmacy = { evening_summary_enabled: false };
const off = ctx.eveningSummaryHtml();
check(/id="evOn"/.test(off) && !/checked/.test(off.match(/id="evOn"[^>]*/)[0]), 'the owner sees the switch, unticked while it is off');
check(/display:none/.test(off), 'the fields are hidden until it is turned on');
ctx.STATE.pharmacy = { evening_summary_enabled: true, evening_summary_phone: '254712345678', evening_summary_sections: ['sales', 'cash'] };
const on = ctx.eveningSummaryHtml();
check(/checked/.test(on.match(/id="evOn"[^>]*/)[0]), 'ticked while it is on');
check(/display:block/.test(on), 'the fields show while it is on');
check(/id="evSec_sales"[^>]*checked/.test(on) && /id="evSec_cash"[^>]*checked/.test(on) && !/id="evSec_stock"[^>]*checked/.test(on), 'only the chosen sections are ticked');
check(/Send a test now/.test(on), 'there is a way to send one right now, without waiting for the evening');

// wiring
check(/sb\.functions\.invoke\('send-sms', \{ body: \{ pharmacy_id: STATE\.profile\.pharmacy_id, mode: 'evening_summary' \} \}\)/.test(cust), 'sending a test now goes through the same send-sms function, in evening-summary mode');
check(/sb\.from\('pharmacies'\)\.update\(payload\)/.test(cust.slice(cust.indexOf('function saveEveningSummary'))), 'saving writes straight to the pharmacy row, same as the rest of Settings');
check(/queueSummary/.test(sender) && /mode === "evening_summary"/.test(sender), 'the Edge Function understands the evening-summary mode');
check(/queue_evening_summary_now/.test(idx), 'it calls the right database function for that mode');
check(/x-cron-secret/.test(cronFn) && /got !== want/.test(cronFn), 'the cron-only sender checks a shared secret, not a person\'s login');
check(/kind", "summary"\)/.test(cronFn) && /status", "queued"\)/.test(cronFn), 'it only ever sends summary messages that are still queued');
check(/from "\.\.\/send-sms\/sender\.ts"/.test(cronFn), 'it reuses the same, already-tested sending code as send-sms (no second copy to go wrong on its own)');

// migration / schema
check(/evening_summary_enabled boolean not null default false/.test(mig), 'off by default for every pharmacy, old and new');
check(/net\.http_post/.test(mig) && /exception when others then[\s\S]{0,60}null;/.test(mig), 'the automatic nudge is best-effort: a problem there never stops the message being queued');
check(/pharma-evening-summary/.test(mig) && /if exists \(select 1 from pg_available_extensions where name = 'pg_cron'\)/.test(mig), 'scheduled the same safe way as the existing nightly housekeeping job');
check(/Folded in from migrations\/2026-11-07_evening_summary\.sql/.test(schema), 'schema.sql carries the migration');
if (failed) process.exit(1);
console.log('evening summary: ok');
