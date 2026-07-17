import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'

export default tseslint.config(
  // ── Ignored paths ───────────────────────────────────────────────────────────
  { ignores: ['dist/**', 'node_modules/**', 'out/**', 'release/**'] },

  // ── TypeScript base (all src/) ──────────────────────────────────────────────
  ...tseslint.configs.recommended,
  {
    // Baseline rules for all source. Conservative by design — the main process
    // is a mature codebase being brought under lint for the first time, so we
    // start at warn for noisy patterns and tighten over time.
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // require() is legitimately used in vitest vi.mock() factories (dynamic
      // CJS mocks). Allow it globally; renderer never uses it.
      '@typescript-eslint/no-require-imports': 'warn',
      // The Function type, no-this-alias, no-unused-expressions, and prefer-const
      // have many legitimate uses in the main process codebase. Warn for now;
      // tighten as the codebase migrates.
      '@typescript-eslint/ban-types': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'prefer-const': 'warn',
    },
  },

  // ── Renderer: the hooks+console rules that prevent #185 ─────────────────────
  //
  // These rules target renderer source only (not main/, not tests in main/).
  // The react-hooks rules catch the specific patterns that cause React error
  // #185 ("Maximum update depth exceeded") and its siblings:
  //   - rules-of-hooks: hooks called conditionally / inside loops
  //   - exhaustive-deps: unstable useEffect deps causing infinite setState loops
  //   - no-unstable-nested-components: inline component defs causing remounts
  //   - no-console: renderer code must use rendererLogger, not console.*
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    settings: {
      react: { version: '19' },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react': react,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
      'no-console': 'error',
      // Tighten these for renderer — they are noisy main-process patterns
      // that do not appear in well-typed renderer code.
      '@typescript-eslint/no-this-alias': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      'prefer-const': 'error',
    },
  },
)
