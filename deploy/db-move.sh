#!/bin/sh
# Copies every row of the public schema from one PostgreSQL database to another and proves the copy is exact.
# Runs inside the nimpat-one-dbmove Cloud Run job (postgres:18 image), never on a laptop, so no address or
# password leaves Google Cloud. The target must already have the same Prisma migrations applied; its rows are
# replaced in one transaction (all or nothing). Addresses come from Secret Manager:
#   SRC, DST       full addresses (a Cloud SQL address may end in &schema=public, which psql does not accept)
#   SRC_DB, DST_DB optional database names that replace nimpat_one in the Cloud SQL address (for rehearsals)
#   MODE           copy (default) or check (compare only, nothing changes)
set -eu
clean() { printf '%s' "$1" | sed -e 's/[?&]schema=public$//' -e 's/&schema=public&/\&/' -e 's/?schema=public&/?/'; }
src=$(clean "$SRC"); dst=$(clean "$DST")
[ -n "${SRC_DB:-}" ] && src=$(printf '%s' "$src" | sed "s#/nimpat_one?#/${SRC_DB}?#")
[ -n "${DST_DB:-}" ] && dst=$(printf '%s' "$dst" | sed "s#/nimpat_one?#/${DST_DB}?#")
export PGCONNECT_TIMEOUT=20
say() { echo "== $*"; }
one() { psql "$1" -X -tA -c "$2"; }

say "source: $(one "$src" "select current_database() || ' on PostgreSQL ' || current_setting('server_version')")"
say "target: $(one "$dst" "select current_database() || ' on PostgreSQL ' || current_setting('server_version')")"

# Same schema history on both sides, or stop before touching anything.
migs="select coalesce(string_agg(migration_name, ',' order by migration_name), '') from _prisma_migrations where finished_at is not null and rolled_back_at is null"
a=$(one "$src" "$migs"); b=$(one "$dst" "$migs")
[ "$a" = "$b" ] || { say "STOP: the migrations differ"; echo "source: $a"; echo "target: $b"; exit 2; }
say "migrations match: $(printf '%s' "$a" | tr ',' '\n' | grep -c .)"

cat > /tmp/verify.sql <<'SQL'
SET TimeZone = 'UTC';
SELECT format('SELECT %L, count(*), md5(coalesce(string_agg(t::text, chr(10) ORDER BY t::text COLLATE "C"), %L)) FROM %I.%I t',
              tablename, '', schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename COLLATE "C"
\gexec
SQL
shape="select (select count(*) from pg_tables where schemaname='public') || ' tables, ' ||
  (select count(*) from pg_indexes where schemaname='public') || ' indexes, ' ||
  (select count(*) from pg_constraint where connamespace='public'::regnamespace and contype in ('p','f','u','c','x')) || ' constraints, ' ||
  (select count(*) from pg_trigger g join pg_class c on c.oid=g.tgrelid where c.relnamespace='public'::regnamespace and not g.tgisinternal) || ' triggers'"

if [ "${MODE:-copy}" = copy ]; then
  f="/backups/move-$(date -u +%Y-%m-%d-%H%M%S)-data.sql"
  say "copying the source rows to $f"
  pg_dump "$src" --data-only --schema=public --exclude-table-data=public._prisma_migrations --no-statistics -f /tmp/data.sql
  cp /tmp/data.sql "$f"
  {
    echo "SET client_min_messages = warning;"
    one "$dst" "select 'TRUNCATE TABLE ' || string_agg(format('%I.%I', schemaname, tablename), ', ') || ' CASCADE;' from pg_tables where schemaname='public' and tablename <> '_prisma_migrations'"
    cat /tmp/data.sql
  } > /tmp/load.sql
  say "loading into the target (one transaction; links between tables are checked as rows arrive)"
  psql "$dst" -X -q -v ON_ERROR_STOP=1 --single-transaction -f /tmp/load.sql
  psql "$dst" -X -q -c "ANALYZE"
fi

say "comparing every table, row by row"
psql "$src" -X -tA -F'|' -f /tmp/verify.sql > /tmp/src.txt
psql "$dst" -X -tA -F'|' -f /tmp/verify.sql > /tmp/dst.txt
say "source shape: $(one "$src" "$shape")"
say "target shape: $(one "$dst" "$shape")"
tables=$(grep -c . /tmp/src.txt); rows=$(awk -F'|' '{s+=$2} END {print s+0}' /tmp/src.txt)
if diff -q /tmp/src.txt /tmp/dst.txt >/dev/null; then
  say "RESULT OK: $tables tables and $rows rows are identical (row counts and fingerprints)"
else
  say "RESULT MISMATCH in these tables (name|source rows|target rows):"
  awk -F'|' 'NR==FNR {n[$1]=$2; h[$1]=$3; next} {seen[$1]=1} n[$1]!=$2 || h[$1]!=$3 {print $1"|"n[$1]"|"$2}
             END {for (t in n) if (!(t in seen)) print t"|"n[t]"|missing"}' /tmp/src.txt /tmp/dst.txt
  exit 3
fi
