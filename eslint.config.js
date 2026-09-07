// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/dist-electron/**',
      '**/dist-packages/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/release/**',
    ],
  },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The renderer is the only React in the repo, so the hooks rules are scoped to it rather than
    // registered repo-wide. Without this block the two `eslint-disable-next-line
    // react-hooks/exhaustive-deps` comments in `components/primitives/` are suppressing a rule
    // ESLint has never heard of, which is itself the error that makes `pnpm run lint` red: a
    // suppression for an unknown rule is reported as `Definition for rule ... was not found`.
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
