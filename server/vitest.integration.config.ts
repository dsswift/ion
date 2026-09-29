import { defineConfig } from 'vitest/config'

/**
 * Separate from `vitest.config.ts` (whose `include` is `src/**\/*.test.{ts,tsx}`
 * only) so `server/tests/integration/*.test.ts` -- which builds and spawns a
 * real `engine/cmd/ion` binary (needs Go on PATH, and runs for seconds, not
 * milliseconds) -- never runs as part of the fast `npm -w server test`
 * dev-loop suite. Run explicitly via `npm -w server run test:integration`.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: true,
    // Must run before any test file's own imports resolve -- see that
    // file's docblock for why (server/src/logger.ts resolves ION_DATA_DIR
    // at top-level module-eval time).
    setupFiles: ['./tests/integration/setup-data-dir.ts'],
    // A real `go build` plus engine boot plus server boot easily exceeds
    // vitest's 5s default per-test timeout on a cold cache.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
