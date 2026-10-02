#!/usr/bin/env bash
# Build, then prove the build is what a consumer gets: package.json's exports are the ones the build wrote, the package
# imports from plain Node, and a consumer on other versions of the shared runtime still typechecks against it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pnpm run build

# The build writes package.json's exports from the generated tree, so a committed map that differs from it is one that
# was edited by hand or not rebuilt after codegen added a package.
git diff --exit-code -- package.json || {
  echo "::error::package.json exports differ from what the build generates. Run 'make build' and commit package.json."
  exit 1
}

"$ROOT/scripts/check-build.sh"
"$ROOT/scripts/check-consumer.sh"
