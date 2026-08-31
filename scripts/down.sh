#!/usr/bin/env bash
# Stop the infra. --volumes erases Postgres data.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--volumes" ]]; then
	echo "→ stopping and erasing volumes"
	docker compose down --volumes
else
	echo "→ stopping (data is kept; pass --volumes to erase it)"
	docker compose down
fi

echo "✓ done"
