import { readdirSync } from 'node:fs';
import { defineConfig } from 'tsdown';

// Every platform package's generated stubs are an entry of their own, published as `./<package>/v1`, so a consumer
// can import the messages and method definitions of the services it calls. They share chunks rather than each inlining
// its own copy of filtering and the well-knowns.
const platformPackages = readdirSync('src/generated/primandproper/platform');

// A bundler rather than tsc because every relative import in src (ts-proto's output included) is extensionless, which
// Node's ESM loader rejects. Rewriting them with ts-proto's importSuffix would make src/generated stop matching DDB's.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing.ts',
    ...Object.fromEntries(
      platformPackages.map((name) => [`${name}/v1`, `src/generated/primandproper/platform/${name}/v1/${name}.ts`]),
    ),
  },
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  dts: true,
  clean: true,
});
