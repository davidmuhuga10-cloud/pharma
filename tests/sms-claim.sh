#!/bin/bash
# Evening-summary queue: proves two senders running AT THE SAME TIME never send
# the same message twice.
#
# This needs two database connections overlapping, which a single .sql file
# cannot do, so it runs two psql processes in parallel. Each records what it
# claimed in _claim_audit, which is then compared - rather than trying to scrape
# ids out of psql's output, which is how an earlier version of this test
# produced nonsense results.
#
# HOW TO RUN (never against production):
#   createdb hodhi_test
#   psql hodhi_test -f tests/00_auth_stub.sql
#   psql hodhi_test -f schema.sql
#   psql hodhi_test -f migrations/2026-11-10_claim_queued_sms.sql
#   bash tests/sms-claim.sh
#
# Override the connection with HODHI_TEST_DB, same as tests/run_tests.js.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="${HODHI_TEST_DB:-postgresql://postgres@localhost/hodhi_test}"
P="psql -q -X -v ON_ERROR_STOP=1 -tA $DB"

fail=0

echo "== Single-connection checks =="
if ! psql -q -X -v ON_ERROR_STOP=1 "$DB" -f "$HERE/sms-claim.sql"; then
  echo "  sms-claim.sql FAILED"
  exit 1
fi

echo
echo "== Two senders claiming at the same time =="
queued=$($P -c "select count(*) from sms_log where kind='summary' and status='queued';")
echo "  queued before: $queued"

# Each worker claims 5 and holds its transaction open for a second, so the two
# genuinely overlap rather than running one after the other.
for w in A B; do
  $P -c "begin;
         insert into _claim_audit (worker, sms_id)
           select '$w', id from claim_queued_summaries(5);
         select pg_sleep(1);
         commit;" >/dev/null 2>&1 &
done
wait

a=$($P -c "select count(*) from _claim_audit where worker='A';")
b=$($P -c "select count(*) from _claim_audit where worker='B';")
both=$($P -c "select count(*) from (select sms_id from _claim_audit group by sms_id having count(distinct worker) > 1) t;")
total=$($P -c "select count(distinct sms_id) from _claim_audit;")
dupes=$($P -c "select count(*) - count(distinct sms_id) from _claim_audit;")
left=$($P -c "select count(*) from sms_log where kind='summary' and status='queued';")

echo "  worker A claimed:        $a"
echo "  worker B claimed:        $b"
echo "  claimed by BOTH:         $both   (must be 0 - this is the whole point)"
echo "  claimed more than once:  $dupes   (must be 0)"
echo "  distinct messages taken: $total"
echo "  still queued after:      $left"

chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (expected $3, got $2)"; fail=$((fail+1)); fi; }

chk "no message was claimed by both senders"        "$both"  "0"
chk "no message was claimed twice at all"           "$dupes" "0"
chk "the two senders took 10 messages between them" "$total" "10"
chk "the queue is empty afterwards"                 "$left"  "0"
chk "worker A and worker B shared the work"         "$((a+b))" "10"

echo
echo "== A sender that dies mid-send does not lose its messages =="
$P -c "update sms_log set status='sending', claimed_at = now() - interval '30 minutes' where kind='summary';" >/dev/null
swept=$($P -c "select requeue_stalled_summaries();")
requeued=$($P -c "select count(*) from sms_log where kind='summary' and status='queued';")
chk "the sweeper recovered every stranded message" "$swept" "10"
chk "they are queued again for the next nudge"     "$requeued" "10"

$P -c "delete from _claim_audit; delete from sms_log where kind='summary';" >/dev/null

echo
if [ "$fail" -gt 0 ]; then
  echo "$fail check(s) FAILED"
  exit 1
fi
echo "ALL CHECKS PASSED - concurrent senders cannot double-send, and a dead sender loses nothing"
