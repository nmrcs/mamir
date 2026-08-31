#!/usr/bin/env bash
# Bulk domain ingest. Cohorts load in parallel via SEPARATE processes:
# with COPY doing the writing, the bottleneck is CSV parsing and Zod in Node,
# which is single-threaded. There is nothing to parallelize inside one process.
#
# Indexes derived from the plugin's axes are built AFTER the load: maintaining
# them during COPY costs three times more than building them once at the end.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PLUGIN=${PLUGIN:-credit_risk}
SOURCE=${SOURCE:-$ROOT/plugins/credit-risk/source.json}
DATA=${DATA:-$ROOT/data/freddie-mac}
# No colon: an empty list is a valid value, not "unset". A monolithic dataset
# (one file, no slices) loads in a single run, and `${VAR:-…}` has no way to
# express that — it would substitute the default and silently load the wrong
# thing.
COHORTS=${COHORTS-1999 2000 2001 2002 2003 2004 2005 2006 2007}
JOBS=${JOBS:-4}

FRESH=0
for arg in "$@"; do
	[[ "$arg" == "--fresh" ]] && FRESH=1
done

npm run build --workspace @mamir/backend >/dev/null

if ((FRESH)); then
	# Scoped DELETE, not TRUNCATE. The entire project is scoped by pluginId —
	# events, indexes, windows, exports; the reset must live by the same rule.
	# TRUNCATE takes no filter and, in a multi-domain database, wipes the
	# neighboring domain along with its own.
	echo "→ clearing events and ingest run log for domain $PLUGIN"
	docker exec mamir-postgres psql -U mamir -d mamir -q \
		-c "DELETE FROM \"Event\" WHERE \"pluginId\" = '$PLUGIN'" \
		-c "DELETE FROM \"IngestRun\" WHERE \"pluginId\" = '$PLUGIN'"
fi

started=$SECONDS

# xargs, not `&` in a loop: it keeps exactly JOBS processes running and returns
# a non-zero code if any of them fails. With `&` a failed cohort would go
# unnoticed.
#
# cwd is apps/backend: ConfigModule reads .env from there, so data paths are
# passed as absolute.
cd "$ROOT/apps/backend"
if [[ -z "$COHORTS" ]]; then
	echo "→ loading the whole dataset in a single run"
	node dist/ingest/ingest.cli.js \
		--plugin "$PLUGIN" --source "$SOURCE" --data "$DATA"
else
	echo "→ loading cohorts ($JOBS in parallel): $COHORTS"
	printf '%s\n' $COHORTS | xargs -P "$JOBS" -I{} \
		node dist/ingest/ingest.cli.js \
		--plugin "$PLUGIN" --source "$SOURCE" --data "$DATA" --cohort {}
fi

echo "→ building indexes on plugin axes"
node dist/windows/windows.cli.js --plugin "$PLUGIN" --what indexes

echo "→ ANALYZE"
docker exec mamir-postgres psql -U mamir -d mamir -q -c 'ANALYZE "Event"'

docker exec mamir-postgres psql -U mamir -d mamir -c "
select cohort, accepted, rejected,
       round(extract(epoch from \"finishedAt\" - \"startedAt\"))::int sec
from \"IngestRun\" where \"pluginId\" = '$PLUGIN' order by cohort;
select count(*) events, pg_size_pretty(pg_total_relation_size('\"Event\"')) size,
       min(\"occurredAt\")::date, max(\"occurredAt\")::date
from \"Event\" where \"pluginId\" = '$PLUGIN';"

echo "✓ done in $((SECONDS - started))s"
