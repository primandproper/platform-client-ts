import { existsSync, readdirSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const platform = 'src/generated/primandproper/platform';

// Every platform package's generated stubs are an entry of their own, published as `./<package>/<version>`, so a
// consumer can import the messages and method definitions of the services it calls. They share chunks rather than each
// inlining its own copy of filtering and the well-knowns. The generated tree is the only list: a package or version that
// codegen adds is built and exported with nothing else to edit.
const platformEntries = readdirSync(platform).flatMap((name) =>
  readdirSync(`${platform}/${name}`).map((version) => {
    const file = `${platform}/${name}/${version}/${name}.ts`;
    if (!existsSync(file)) {
      throw new Error(`${platform}/${name}/${version} has no ${name}.ts to publish as ./${name}/${version}`);
    }
    return [`${name}/${version}`, file];
  }),
);

// A bundler rather than tsc because every relative import in src (ts-proto's output included) is extensionless, which
// Node's ESM loader rejects. Rewriting them with ts-proto's importSuffix would make src/generated stop matching DDB's.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing.ts',
    ...Object.fromEntries(platformEntries),
  },
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  dts: true,
  clean: true,
  // The build writes package.json's exports from the entries above. CI fails if the committed exports differ from
  // what the build wrote, so they are never edited by hand.
  exports: true,
});
