#!/usr/bin/env bash
# Import the built package the way a consumer would: by name, through package.json's exports, from a plain Node
# process with no bundler in the way. Node's ESM loader rejects extensionless relative imports, which the source is
# full of, so this is what fails when the build stops rewriting them. Run `pnpm run build` first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f dist/index.mjs ] || { echo "::error::no dist/index.mjs — run 'pnpm run build' first"; exit 1; }

node --input-type=module -e "
const main = await import('@primandproper/platform-client');
const testing = await import('@primandproper/platform-client/testing');
for (const [entry, mod, name] of [['.', main, 'Session'], ['./testing', testing, 'FakeTransport']]) {
  if (typeof mod[name] !== 'function') {
    console.error(\`::error::\${entry} imported, but has no \${name} export\`);
    process.exit(1);
  }
}
const exportsMap = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync('package.json', 'utf8'))).exports;
for (const entry of Object.keys(exportsMap).filter((e) => e.endsWith('/v1'))) {
  const mod = await import('@primandproper/platform-client' + entry.slice(1));
  if (Object.keys(mod).length === 0) {
    console.error(\`::error::\${entry} imported, but exports nothing\`);
    process.exit(1);
  }
}
console.log('built package imports from plain Node');
"
