import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'

export default tseslint.config(
  // ── Ignored paths ───────────────────────────────────────────────────────────
  { ignores: ['dist/**', 'node_modules/**', 'out/**', 'release/**'] },

  // ── TypeScript base (all src/) ──────────────────────────────────────────────
  ...tseslint.configs.recommended,
  {
    // Type-aware linting is enabled here (projectService) so the three
    // silent-failure rules below — no-floating-promises, no-misused-promises,
    // no-empty — can fire. These require type information; without a parser
    // project they cannot run. Scoped to src/ TypeScript only.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
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
      // ── Silent-failure gates (ADR observability pass) ──────────────────────
      // A floating promise swallows its rejection; a misused promise (async fn
      // passed where a void callback is expected) drops errors on the floor; an
      // empty catch hides the failure entirely. All three are the "no silent
      // failures" rule enforced structurally. Genuinely-intentional empties
      // carry `// eslint-disable-next-line no-empty -- <reason>`.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-empty': 'error',
    },
  },

  // Test files: the silent-failure gates are relaxed. Tests routinely fire
  // floating promises (fixture setup) and use empty catches to probe error
  // paths; enforcing there is noise, not safety.
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      'no-empty': 'off',
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
