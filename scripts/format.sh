#!/usr/bin/env bash
# Run prettier over everything it formats, writing by default or checking with --check. One list, so CI and a local
# run never disagree about which files count. src/generated is in it because the codegen check formats its output the
# same way before comparing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="--write"
if [ "${1:-}" = "--check" ]; then
  MODE="--check"
fi

pnpm exec prettier "$MODE" --log-level warn 'src/**/*.ts' '*.json' '*.md' '*.mjs' '.github/**/*.yml'
