#!/usr/bin/env bash
# ESLint over the TypeScript and shellcheck over the scripts, which gate releases and CI as much as the code does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v shellcheck >/dev/null || { echo "::error::shellcheck is not installed"; exit 1; }

pnpm exec eslint --max-warnings 0 .
shellcheck scripts/*.sh
