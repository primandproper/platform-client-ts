import { defineConfig } from 'tsdown';

// A bundler rather than tsc because every relative import in src (ts-proto's output included) is extensionless, which
// Node's ESM loader rejects. Rewriting them with ts-proto's importSuffix would make src/generated stop matching DDB's.
export default defineConfig({
  entry: ['src/index.ts', 'src/testing.ts'],
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  dts: true,
  clean: true,
});
