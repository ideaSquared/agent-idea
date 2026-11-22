import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', '.wrangler/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.serviceworker } },
  },
  {
    // Server code logs through @ideasquared/log (see .claude/skills/logging). The CLI prints to a terminal.
    files: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
    ignores: ['src/cli/**'],
    rules: { 'no-console': 'error' },
  },
);
