// The platform admin (support) account must not appear in a pharmacy's Staff list.
// DB half: hidden_staff_ids() returns the admin ids inside the caller's pharmacy (exercised live in a
// rolled-back test, see migrations/2026-11-09_hide_platform_admin_from_staff.sql). App half: the list drops them.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
let failed = 0;
function check(ok, msg) { if (!ok) { failed++; console.log('FAIL ' + msg); } }
function read(p) { return fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), 'utf8') : ''; }

const mig = read('migrations/2026-11-09_hide_platform_admin_from_staff.sql');
const rb = read('migrations/2026-11-09_hide_platform_admin_from_staff.ROLLBACK_if_needed.sql');
const schema = read('schema.sql');
const js = read('js/claims-settings.js');

check(/create or replace function public\.hidden_staff_ids\(\)/.test(mig), 'migration creates hidden_staff_ids()');
check(/security definer set search_path to 'public'/.test(mig), 'hidden_staff_ids is security definer with a fixed search_path');
check(/revoke all on function public\.hidden_staff_ids\(\) from public, anon;/.test(mig) && /grant execute on function public\.hidden_staff_ids\(\) to authenticated;/.test(mig), 'hidden_staff_ids is not callable by anon');
check(/p\.pharmacy_id = my_pharmacy_id\(\) or p\.id = auth\.uid\(\)/.test(mig) && /platform_admins/.test(mig), 'it covers the pharmacy the caller works in AND the caller\'s own profile row (an admin in support mode sees their own row in another pharmacy)');
check(/drop function if exists public\.hidden_staff_ids\(\)/.test(rb), 'rollback file drops the function');
check(/Folded in from migrations\/2026-11-09_hide_platform_admin_from_staff\.sql/.test(schema) && /create or replace function public\.hidden_staff_ids\(\)/.test(schema), 'schema.sql carries the function');

check(/rpc\('hidden_staff_ids'\)/.test(js), 'Settings asks the database which staff to hide');
const i = js.indexOf('function withoutHiddenStaff(');
if (i < 0) check(false, 'withoutHiddenStaff exists in js/claims-settings.js');
else {
  let d = 0, j = js.indexOf('{', i), src = '';
  for (let k = j; k < js.length; k++) { if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (d === 0) { src = js.slice(i, k + 1); break; } } }
  const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
  const staff = [{ id: 'a', role: 'owner' }, { id: 'b', role: 'co_owner' }, { id: 'c', role: 'attendant' }];
  const r1 = ctx.withoutHiddenStaff(staff, ['b']);
  check(r1.length === 2 && r1.every(function (s) { return s.id !== 'b'; }), 'the hidden person is removed, everyone else stays');
  check(ctx.withoutHiddenStaff(staff, []).length === 3, 'nothing hidden: the list is unchanged');
  check(ctx.withoutHiddenStaff(staff, null).length === 3, 'no answer from the database: the list is unchanged, Settings still loads');
  check(ctx.withoutHiddenStaff(staff, ['b', 'c']).length === 1, 'several hidden people are all removed');
}

console.log(failed ? failed + ' hidden-admin checks failed' : 'PASS hidden-admin: the platform admin is not shown in a pharmacy Staff list');
process.exit(failed ? 1 : 0);
