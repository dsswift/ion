import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Same zero-tolerance rule as the desktop renderer (ADR-019): a
      // console.* line goes to a stream nobody collects -- in a container,
      // nowhere at all -- while server.jsonl, the file an investigation
      // actually reads, says nothing happened. Use logger.ts.
      'no-console': 'error',
    },
  },
  {
    // Two places where stdout IS the interface rather than a log stream: the
    // CLI, which prints a pairing code for a person to read, and tests, whose
    // output a person reads directly. Matches what `scripts/check-logging.sh`
    // scans, which skips test files for the same reason.
    files: ['src/cli/**/*.ts', 'src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
)
