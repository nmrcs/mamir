#!/usr/bin/env bash
# Bring up the infra and wait until it is ready. Without the wait the next
# step hits "connection refused" on a still-starting Postgres.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ starting postgres"
docker compose up -d

TIMEOUT=90
echo "→ waiting for healthy (timeout ${TIMEOUT}s)"

deadline=$((SECONDS + TIMEOUT))
while :; do
	# -a is mandatory: without it a crashed container simply disappears from
	# the output, the empty list reads as "all healthy", and the script
	# reports success on a dead DB.
	snapshot=$(docker compose ps -a --format '{{.Service}} {{.State}} {{.Health}}')

	if [[ -z "$snapshot" ]]; then
		echo "✗ containers were not created" >&2
		exit 1
	fi

	if grep -qiE ' (exited|dead)( |$)' <<<"$snapshot"; then
		echo "✗ container crashed:" >&2
		echo "$snapshot" >&2
		docker compose logs --tail 30 >&2
		exit 1
	fi

	pending=$(awk '$3 != "healthy" { print $1 }' <<<"$snapshot")

	if [[ -z "$pending" ]]; then
		break
	fi

	if ((SECONDS >= deadline)); then
		echo "✗ timed out waiting for: $(echo "$pending" | tr '\n' ' ')" >&2
		docker compose ps -a
		exit 1
	fi

	sleep 2
done

docker compose ps
echo "✓ done"
