#!/usr/bin/env bash
# Publish the version package.json names, then tag the commit it was built from. Everything that can refuse does so
# before the slow part: a version npm would mangle or reject, one already published, one lower than the highest
# published (a stale checkout or a forgotten bump), and a tree that is not exactly origin/main. Then the checks CI runs,
# against the tree being packed, because dist/ is built here and nowhere else.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

npm whoami >/dev/null 2>&1 || { echo "::error::not logged in to npm: run 'npm login'"; exit 1; }

# A 404 is a package that has never been published. Any other failure is not a reason to assume that.
if ! npm view "$NAME" versions --json >"$WORK/published.json" 2>"$WORK/view.err"; then
  grep -q E404 "$WORK/view.err" || { cat "$WORK/view.err"; exit 1; }
  echo '[]' >"$WORK/published.json"
fi

# Prints the dist-tag the version publishes under, or explains why it cannot be published and fails.
DIST_TAG="$(node --input-type=module - "$VERSION" "$WORK/published.json" <<'EOF'
import { readFileSync } from 'node:fs';

const [version, publishedPath] = process.argv.slice(2);
const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

// semver.org's grammar, minus build metadata: npm drops it, so 1.0.0+a would publish as 1.0.0.
const ident = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const grammar = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${ident}(?:\\.${ident})*))?$`);

const parse = (v) => {
  const m = grammar.exec(v);
  return m && { core: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split('.') : [] };
};

const compareIdent = (a, b) => {
  const [an, bn] = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (an && bn) return Number(a) - Number(b);
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

const compare = (a, b) => {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const c = compareIdent(a.pre[i], b.pre[i]);
    if (c !== 0) return c;
  }
  return a.pre.length - b.pre.length;
};

const next = parse(version);
if (!next) fail(`${version} is not a valid version (MAJOR.MINOR.PATCH, optionally -PRERELEASE, no +BUILD)`);

// npm view prints a bare string when exactly one version is published.
const published = [JSON.parse(readFileSync(publishedPath, 'utf8'))].flat();
if (published.includes(version)) fail(`${version} is already published: bump the version in package.json`);

const highest = published
  .map((v) => [v, parse(v)])
  .filter(([, p]) => p)
  .sort(([, a], [, b]) => compare(b, a))[0];
if (highest && compare(next, highest[1]) <= 0) fail(`${version} is not after ${highest[0]}, the highest published`);

// A prerelease published as latest is what every unpinned install would get.
console.log(next.pre.length ? 'next' : 'latest');
EOF
)"

[ "$(git branch --show-current)" = main ] || { echo "::error::publish from main"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "::error::the working tree is not clean"; exit 1; }
git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "::error::HEAD is not origin/main"; exit 1; }
if git rev-parse --quiet --verify "refs/tags/$TAG" >/dev/null || git ls-remote --exit-code --tags origin "$TAG" >/dev/null; then
  echo "::error::$TAG is already tagged"
  exit 1
fi

pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm test
pnpm run build
git diff --exit-code -- package.json || { echo "::error::the build rewrote package.json's exports"; exit 1; }
pnpm run check-build
pnpm run check-consumer

# The git checks pnpm would make are the ones above, made before the build rather than after it.
pnpm publish --no-git-checks --tag "$DIST_TAG"

git tag "$TAG"
git push origin "$TAG"

echo "published $NAME@$VERSION as $DIST_TAG, tagged $TAG"
