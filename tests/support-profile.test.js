// The Profile button, change password and "Get support" (js/profile.js, shell.js, admin.js and
// migrations/2026-11-07_support_access.sql). Run from the project folder:
//   node tests/support-profile.test.js
const fs = require('fs'), path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const shell = read('js/shell.js'), prof = read('js/profile.js'), admin = read('admin.js'), mig = read('migrations/2026-11-07_support_access.sql'), schema = read('schema.sql');
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error('FAIL ' + msg); } };
const fn = (src, name) => { const i = src.search(new RegExp('(async )?function ' + name + '\\(')); if (i < 0) return ''; const m = src.slice(i).match(/\n\}/); return src.slice(i, i + (m ? m.index : 3000)); };

// Top bar: a Profile button instead of Log out.
check(/class="profbtn" onclick="openProfile\(\)"/.test(shell), 'the top bar has a Profile button');
check(!/<button onclick="logout\(\)">Log out<\/button>/.test(shell), 'the top bar no longer has a Log out button');
check(/closeSheet\(\);logout\(\)/.test(fn(prof, 'openProfile')), 'Sign out is inside Profile');

// Change password: current password checked first, eye on every box, 8+ characters.
const cp = fn(prof, 'openChangePassword') + fn(prof, 'doChangePassword');
check(['cpOld', 'cpNew', 'cpNew2'].every(id => new RegExp("pwField\\('" + id + "'").test(cp)), 'all three password boxes have the eye (pwField)');
check(/signInWithPassword\(\{ email: email, password: oldPw \}\)/.test(cp), 'the current password is checked before changing it');
check(/updateUser\(\{ password: pw \}\)/.test(cp) && /pw\.length < 8/.test(cp) && /pw !== pw2/.test(cp), 'new password: 8+ characters, typed twice');

// Get support: owner and co-owner only, 1/2/4/8/24 hours, same list as the database.
check(/p\.role === 'owner' \|\| p\.role === 'co_owner'/.test(fn(prof, 'openProfile')) && /!STATE\.support/.test(fn(prof, 'openProfile')), 'Get support is shown to the owner and co-owner only (not in support mode)');
const hours = (prof.match(/SUPPORT_HOURS = \[([^\]]*)\]/) || [])[1];
check(hours && hours.replace(/\s/g, '') === '1,2,4,8,24', 'the app offers 1, 2, 4, 8 and 24 hours');
check(/p_hours not in \(1, 2, 4, 8, 24\)/.test(mig), 'the database accepts the same hours');
check(/grant_support_access/.test(prof) && /revoke_support_access/.test(prof) && /my_support_access/.test(prof), 'the app calls grant, stop and read for support access');
check(/Pharma admin will get access to your pharmacy/.test(prof), 'the owner is told that the Pharma admin gets access before granting');
check(/Stop access now/.test(prof), 'the owner can stop access at any time');

// Support mode: the admin acts as the pharmacy, sees a banner, can leave, borrowed identity is not cached.
check(/rpc\('support_context'\)/.test(shell) && /role: 'co_owner'/.test(shell), 'shell.js asks for the support context and acts as that pharmacy');
check(/if \(STATE\.support\) clearProfileCache\(\); else saveProfileCache\(\)/.test(shell), 'a support identity is never saved on the device');
check(/supportBannerHtml\(\)/.test(shell) && /admin_close_support/.test(fn(prof, 'leaveSupport')), 'a banner shows in support mode, with Leave');

// Admin console: sees who gave access and opens it.
check(/admin_support_status/.test(admin) && /admin_open_support/.test(admin) && /function supportCard/.test(admin), 'admin console shows support access and can open it');
check((admin.match(/supportBadge\(/g) || []).length >= 4, 'pharmacy lists show a "Support access on" badge');

// Database pieces exist in both the migration and schema.sql.
['grant_support_access', 'revoke_support_access', 'my_support_access', 'admin_support_status', 'admin_open_support', 'admin_close_support', 'support_context']
  .forEach(f => { check(mig.includes('function public.' + f), f + ' is in the migration'); check(schema.includes('function public.' + f), f + ' is in schema.sql'); });
check(/revoke all on public\.support_access, public\.support_session, public\.support_access_events from anon, authenticated/.test(mig), 'support tables are closed to the app');

if (failed) process.exit(1);
// The admin can open any pharmacy directly (no grant, no password, no code); Get support stays.
const dm = read('migrations/2026-11-07_admin_direct_access.sql');
check(!/Not given|not given/.test(admin) && /id="btnOpenSupport"/.test(admin) && (admin.match(/openBtn/g) || []).length >= 3, 'the admin console always offers "Open this pharmacy", with or without a grant');
check(!/has not given support access/.test(dm) && /opened_direct/.test(dm), 'the database no longer needs a grant to open, and logs direct opens');
check(/interval '8 hours'/.test(dm), 'a direct session closes by itself after 8 hours');
check(/grant_support_access/.test(prof) && /Get support/.test(prof), 'Get support is still in the owner\'s Profile');
check(!/password|service_role|SERVICE_ROLE/i.test(dm.replace(/--[^\n]*/g, '')), 'no password or service key is used to open a pharmacy');
check(/Folded in from migrations\/2026-11-07_admin_direct_access\.sql/.test(schema), 'schema.sql carries the direct-access change');
console.log('support and profile: ok');
