#!/usr/bin/env bash
# Regenerating must reproduce exactly what is committed. This catches a hand-edited generated file, a pin that was
# bumped without regenerating, and a regeneration that was never committed: three ways for the checked-in client to
# stop describing the server. Needs protoc on the PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pnpm run codegen
pnpm exec prettier --write --log-level warn 'src/generated/**/*.ts'

git diff --exit-code -- src/generated || {
  echo "::error::src/generated does not match what $(cat PLATFORM_GO_VERSION) generates. Run 'make codegen'."
  exit 1
}
