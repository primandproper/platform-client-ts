import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// src/generated is ts-proto's output and CI proves it matches the pinned tag byte for byte, so it is never edited to
// satisfy a rule.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'src/generated/', '.protos/', 'third_party/'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // A test indexes a recorded call after asserting it happened. If the call is not there, the `!` fails the test with a
    // TypeError, which is the outcome a guard would produce.
    files: ['src/**/*.test.ts', 'src/**/*.conformance.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
