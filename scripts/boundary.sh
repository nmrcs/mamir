#!/usr/bin/env bash
# Core/plugin boundary: the core must not reference plugins, statically or via
# package.json. Enforced by a script, not by eyeballing during review.
set -euo pipefail

cd "$(dirname "$0")/.."

# What is checked is a package-boundary crossing: importing a plugin package by
# name, or a relative path escaping apps/backend. The src/plugins directory is
# the core's registry — it is not a plugin.
if grep -rnE "@mamir/plugin-|\.\./\.\./plugins/" apps/backend/src --include="*.ts" | grep -v generated; then
	echo "✗ core references a plugin" >&2
	exit 1
fi

node -e "
	const p = require('./apps/backend/package.json')
	const deps = { ...p.dependencies, ...p.devDependencies }
	const bad = Object.keys(deps).filter((d) => d.startsWith('@mamir/plugin-'))
	if (bad.length) { console.error('plugin declared as a core dependency:', bad); process.exit(1) }
"

echo "✓ boundary intact"
