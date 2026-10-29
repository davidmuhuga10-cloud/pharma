// Tests for the send-sms Edge Function's logic (supabase/functions/send-sms/sender.ts),
// run with a fake database and a fake SMS provider, so nothing real is sent.
// Needs Node 22+ (it reads the TypeScript file directly).
//
//   node --experimental-strip-types tests/send-sms.test.js
//
// Run through `npm test`, which passes the flag.

const assert = require('assert');
const path = require('path');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

(async () => {
  const { handle, sendOne, apiBase, isConfigured, friendlyDeliveryText } =
    await import(path.join(__dirname, '..', 'supabase', 'functions', 'send-sms', 'sender.ts'));

  function fakeDeps(over) {
    const marks = [];
    const calls = [];
    const deps = {
      queue: async () => ({ data: { queued: [{ id: 'a', to: '254712345678', body: 'Hello' }, { id: 'b', to: '254722000111', body: 'Hi' }], skipped: [], used_today: 2, daily_cap: 30 }, error: null }),
      loadConfig: async () => ({ username: 'pharma', api_key: 'KEY', sender_id: 'PHARMA' }),
      mark: async (id, patch) => { marks.push({ id, patch }); },
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return { json: async () => ({ SMSMessageData: { Recipients: [{ status: 'Success', messageId: 'ATXid_' + calls.length, number: '+254712345678' }] } }) };
      },
      now: () => '2026-10-29T10:00:00.000Z'
    };
    return { deps: Object.assign(deps, over || {}), marks, calls };
  }

  console.log('\n== send-sms logic ==');
  ok(apiBase({ username: 'sandbox' }) === 'https://api.sandbox.africastalking.com', 'the sandbox account uses the sandbox address');
  ok(apiBase({ username: 'pharma' }) === 'https://api.africastalking.com', 'a real account uses the live address');
  ok(isConfigured({ username: 'x', api_key: 'y' }) && !isConfigured({ username: 'x' }) && !isConfigured(null), 'configuration needs both a username and a key');
  ok(/out of balance/.test(friendlyDeliveryText('InsufficientBalance')), 'provider errors are turned into plain words');

  let t = fakeDeps();
  let r = await handle({ pharmacy_id: 'p1', messages: [{ customer_id: 'c', body: 'x', kind: 'custom' }] }, t.deps);
  ok(r.ok && r.sent === 2 && r.failed === 0, 'two queued messages are both sent');
  ok(t.calls.length === 2 && t.calls[0].url === 'https://api.africastalking.com/version1/messaging', 'each goes to the provider once');
  ok(t.calls[0].init.headers.apiKey === 'KEY' && /to=%2B254712345678/.test(t.calls[0].init.body) && /from=PHARMA/.test(t.calls[0].init.body), 'the number goes with a + and the sender name is included');
  ok(t.marks.length === 2 && t.marks.every((m) => m.patch.status === 'sent' && m.patch.sent_at), 'every log row is marked sent with a time');
  ok(!JSON.stringify(r).includes('KEY'), 'the provider key never appears in what the browser receives');

  t = fakeDeps({ queue: async () => ({ data: null, error: { message: 'Daily SMS limit reached (30 a day). Try again tomorrow.' } }) });
  r = await handle({ pharmacy_id: 'p1', messages: [{}] }, t.deps);
  ok(r.ok === false && /Daily SMS limit/.test(r.message) && t.calls.length === 0, 'when the database refuses (limit, role) nothing is sent and the reason is passed on');

  t = fakeDeps({ queue: async () => ({ data: { queued: [], skipped: [{ customer_id: 'c', reason: 'opted_out' }], used_today: 0, daily_cap: 30 }, error: null }) });
  r = await handle({ pharmacy_id: 'p1', messages: [{}] }, t.deps);
  ok(r.ok && r.sent === 0 && r.skipped.length === 1 && t.calls.length === 0, 'if everything was skipped nothing is sent');

  t = fakeDeps({ loadConfig: async () => ({}) });
  r = await handle({ pharmacy_id: 'p1', messages: [{}] }, t.deps);
  ok(r.ok && r.sent === 0 && r.failed === 2 && t.marks.every((m) => m.patch.status === 'failed' && /not set up/.test(m.patch.error)) && t.calls.length === 0,
    'with no provider set up the rows are marked failed, not left as queued');

  t = fakeDeps({ fetchFn: async () => ({ json: async () => ({ SMSMessageData: { Recipients: [{ status: 'InvalidPhoneNumber' }] } }) }) });
  r = await handle({ pharmacy_id: 'p1', messages: [{}] }, t.deps);
  ok(r.failed === 2 && t.marks[0].patch.status === 'failed' && /invalid/.test(t.marks[0].patch.error), 'a provider rejection marks the row failed with a plain reason');

  t = fakeDeps({ fetchFn: async () => { throw new Error('network down'); } });
  r = await handle({ pharmacy_id: 'p1', messages: [{}] }, t.deps);
  ok(r.failed === 2 && /Could not reach/.test(t.marks[0].patch.error), 'a network failure marks the row failed instead of crashing');

  let n = 0;
  t = fakeDeps({ fetchFn: async () => { const mine = ++n; return { json: async () => (mine === 1 ? { SMSMessageData: { Recipients: [{ status: 'Success', messageId: 'm1' }] } } : { SMSMessageData: { Recipients: [{ status: 'UserInBlacklist' }] } }) }; } });
  r = await handle({ pharmacy_id: 'p1', messages: [{}] }, t.deps);
  ok(r.sent === 1 && r.failed === 1, 'one success and one failure are reported separately');

  r = await handle({ pharmacy_id: '', messages: [] }, fakeDeps().deps);
  ok(r.ok === false, 'an empty request is refused');
  r = await handle(null, fakeDeps().deps);
  ok(r.ok === false, 'a missing body is refused');

  const bad = await sendOne({ username: 'u', api_key: 'k' }, { id: 'z', to: '12', body: 'x' }, async () => { throw new Error('should not be called'); });
  ok(bad.status === 'failed' && /usable phone/.test(bad.error), 'a number that is too short is never sent');

  console.log('\n' + pass + ' passed, 0 failed');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
