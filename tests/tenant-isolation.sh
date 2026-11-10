#!/bin/bash
# Does one pharmacy's sale ever block another pharmacy's sale?
#
# This is the claim the whole multi-pharmacy design rests on: each pharmacy is
# its own unit of contention, so one busy or stuck till never slows anybody
# else down. It is measured here rather than assumed, by holding one sale's
# transaction open and timing what another connection can do meanwhile.
#
# Expected:
#   a DIFFERENT pharmacy's sale   -> finishes immediately (no waiting)
#   the SAME batch, same pharmacy -> waits for the first to commit, which is
#                                    correct: they are competing for the same
#                                    physical units of stock
#
# HOW TO RUN (never against production):
#   createdb hodhi_test
#   psql hodhi_test -f tests/00_auth_stub.sql
#   psql hodhi_test -f schema.sql
#   bash tests/tenant-isolation.sh
set -u
DB="${HODHI_TEST_DB:-postgresql://postgres@localhost/hodhi_test}"
P="psql -q -X -v ON_ERROR_STOP=1 -tA $DB"
fail=0

echo "== setup: two pharmacies, one drug and one batch each =="
$P <<'SQL' >/dev/null
drop table if exists _iso;
create table _iso (k text primary key, v text);
do $$
declare oa uuid; ob uuid; pa uuid; pb uuid; da uuid; db2 uuid;
begin
  insert into auth.users default values returning id into oa;
  perform test_set_user(oa);
  pa := bootstrap_pharmacy('Iso A','Owner A','0700001001');
  insert into drugs (pharmacy_id,name,form,unit) values (pa,'Drug A','tablet','tablet') returning id into da;
  insert into batches (pharmacy_id,drug_id,batch_no,quantity_received,quantity_remaining,cost_price,sell_price,expiry_date)
    values (pa,da,'A1',1000,1000,10,20,current_date+365);

  insert into auth.users default values returning id into ob;
  perform test_set_user(ob);
  pb := bootstrap_pharmacy('Iso B','Owner B','0700001002');
  insert into drugs (pharmacy_id,name,form,unit) values (pb,'Drug B','tablet','tablet') returning id into db2;
  insert into batches (pharmacy_id,drug_id,batch_no,quantity_received,quantity_remaining,cost_price,sell_price,expiry_date)
    values (pb,db2,'B1',1000,1000,10,20,current_date+365);

  insert into _iso values ('pa',pa::text),('pb',pb::text),('da',da::text),('db',db2::text),
                          ('oa',oa::text),('ob',ob::text);
end $$;
SQL
PA=$($P -c "select v from _iso where k='pa';"); DA=$($P -c "select v from _iso where k='da';"); OA=$($P -c "select v from _iso where k='oa';")
PB=$($P -c "select v from _iso where k='pb';"); DB_=$($P -c "select v from _iso where k='db';"); OB=$($P -c "select v from _iso where k='ob';")
echo "  pharmacy A $PA / pharmacy B $PB"

sell_sql() { # $1 owner  $2 pharmacy  $3 drug
  echo "select test_set_user('$1');
        select record_sale('$2',
          jsonb_build_array(jsonb_build_object('drug_id','$3','quantity',1)),
          jsonb_build_array(jsonb_build_object('method','cash','amount',20)));"
}

echo
echo "== hold a sale open in pharmacy A for 3 seconds =="
( $P -c "begin; $(sell_sql $OA $PA $DA) select pg_sleep(3); commit;" >/dev/null 2>&1 ) &
HOLDER=$!
sleep 1   # make sure the holder has taken its locks

echo "== meanwhile, pharmacy B sells =="
S=$(date +%s%N)
$P -c "$(sell_sql $OB $PB $DB_)" >/dev/null 2>&1
B_MS=$(( ($(date +%s%N) - S) / 1000000 ))
echo "  pharmacy B's sale took ${B_MS} ms"

echo "== meanwhile, pharmacy A sells the SAME batch again =="
S=$(date +%s%N)
$P -c "$(sell_sql $OA $PA $DA)" >/dev/null 2>&1
A_MS=$(( ($(date +%s%N) - S) / 1000000 ))
echo "  pharmacy A's second sale took ${A_MS} ms"

wait $HOLDER

chk() { if [ "$2" = "yes" ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=$((fail+1)); fi; }

# B must not have waited for A. Allow generous headroom for a slow machine.
if [ "$B_MS" -lt 1200 ]; then R=yes; else R=no; fi
chk "another pharmacy's sale is NOT blocked (took ${B_MS}ms, not ~2000ms)" "$R"

# A's second sale on the same batch must have waited for the holder to commit.
if [ "$A_MS" -gt 1000 ]; then R=yes; else R=no; fi
chk "the same batch DOES serialise, so stock cannot be sold twice (waited ${A_MS}ms)" "$R"

echo
echo "== stock arithmetic survived the concurrency =="
AQ=$($P -c "select quantity_remaining from batches where pharmacy_id='$PA';")
BQ=$($P -c "select quantity_remaining from batches where pharmacy_id='$PB';")
AS=$($P -c "select count(*) from sales where pharmacy_id='$PA';")
BS=$($P -c "select count(*) from sales where pharmacy_id='$PB';")
echo "  pharmacy A: $AS sales, batch left $AQ (expect 2 sales, 998)"
echo "  pharmacy B: $BS sales, batch left $BQ (expect 1 sale, 999)"
if [ "$AQ" = "998" ] && [ "$AS" = "2" ]; then R=yes; else R=no; fi
chk "pharmacy A's stock is exactly right" "$R"
if [ "$BQ" = "999" ] && [ "$BS" = "1" ]; then R=yes; else R=no; fi
chk "pharmacy B's stock is exactly right" "$R"

$P -c "drop table if exists _iso;" >/dev/null

echo
if [ "$fail" -gt 0 ]; then echo "$fail check(s) FAILED"; exit 1; fi
echo "ALL CHECKS PASSED - pharmacies do not contend with each other; the same batch correctly does"
