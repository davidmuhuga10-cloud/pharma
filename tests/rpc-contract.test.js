// The app and the database must agree on names.
// 1) Every database function the browser code calls (sb.rpc / rpcCall) is created in schema.sql or a migration.
// 2) Every edge function it invokes has a folder in supabase/functions.
// 3) Every edge function folder deployed with a local import only imports files inside its own folder
//    (a function that imports "../other/x.ts" fails to deploy on its own).
// A renamed or dropped function otherwise shows up only as a broken button in front of a customer.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(ok, msg) { if (!ok) { failed++; console.log('FAIL ' + msg); } }

function read(p) { return fs.readFileSync(p, 'utf8'); }
function listJs() { return fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'js', f)); }

// --- what the code calls
const rpcCalls = {};      // name -> 'file:line'
const invokes = {};
listJs().concat(['admin.js', 'auth.js'].map((f) => path.join(root, f)).filter(fs.existsSync)).forEach((file) => {
  read(file).split('\n').forEach((line, i) => {
    const where = path.relative(root, file) + ':' + (i + 1);
    let m;
    const rpc = /(?:\.rpc|rpcCall)\(\s*['"]([a-z0-9_]+)['"]/g;
    while ((m = rpc.exec(line))) if (!rpcCalls[m[1]]) rpcCalls[m[1]] = where;
    const inv = /functions\.invoke\(\s*['"]([a-z0-9_-]+)['"]/g;
    while ((m = inv.exec(line))) if (!invokes[m[1]]) invokes[m[1]] = where;
  });
});
check(Object.keys(rpcCalls).length > 10, 'found the rpc calls in js/ (found ' + Object.keys(rpcCalls).length + ')');

// --- what the database defines (rollback files are not definitions)
const sqlFiles = ['schema.sql', 'supabase_admin_portal.sql']
  .map((f) => path.join(root, f)).filter(fs.existsSync);
const migDir = path.join(root, 'migrations');
if (fs.existsSync(migDir)) {
  fs.readdirSync(migDir).filter((f) => f.endsWith('.sql') && !/ROLLBACK/i.test(f)).forEach((f) => sqlFiles.push(path.join(migDir, f)));
}
const defined = {};
sqlFiles.forEach((file) => {
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi;
  let m; const s = read(file);
  while ((m = re.exec(s))) defined[m[1].toLowerCase()] = true;
});
Object.keys(rpcCalls).forEach((n) => check(defined[n], 'js calls rpc "' + n + '" (' + rpcCalls[n] + ') but no create function ' + n + ' in schema.sql or migrations/'));

// --- edge functions
const fnDir = path.join(root, 'supabase', 'functions');
const fnFolders = fs.existsSync(fnDir) ? fs.readdirSync(fnDir).filter((f) => fs.statSync(path.join(fnDir, f)).isDirectory()) : [];
Object.keys(invokes).forEach((n) => check(fnFolders.indexOf(n) !== -1, 'js invokes edge function "' + n + '" (' + invokes[n] + ') but supabase/functions/' + n + ' does not exist'));
fnFolders.forEach((n) => {
  const idx = path.join(fnDir, n, 'index.ts');
  check(fs.existsSync(idx), 'supabase/functions/' + n + '/index.ts exists');
  if (!fs.existsSync(idx)) return;
  read(idx).split('\n').forEach((line, i) => {
    if (/^\s*import\b.*from\s+["']\.\.\//.test(line)) check(false, 'supabase/functions/' + n + '/index.ts:' + (i + 1) + ' imports from outside its own folder; copy the file into the folder instead');
  });
});

console.log(failed ? failed + ' rpc-contract checks failed' : 'PASS rpc-contract: ' + Object.keys(rpcCalls).length + ' database functions and ' + Object.keys(invokes).length + ' edge functions the app calls all exist');
process.exit(failed ? 1 : 0);
