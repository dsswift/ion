import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      // Unit tests run under plain Node where the real electron package is
      // unusable: its index.js resolves the Electron BINARY path and throws
      // "Electron failed to install correctly" when the binary is absent
      // (npm ci --ignore-scripts — CI and the Linux parity gate). Alias it
      // to a load-safe stub so main-process modules with top-level electron
      // imports stay loadable. vi.mock('electron', ...) still takes
      // precedence for tests that need specific behavior.
      electron: resolve(__dirname, 'src/test/electron-stub.ts'),
    },
  },
  test: {
    // Matches both legacy `__tests__/` directories and co-located
    // `Foo.test.ts(x)` files (the convention in CLAUDE.md; `__tests__/`
    // migrates per phase).
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    globals: true,
    // Git/worktree integration tests execute real repositories and routinely
    // need more than Vitest's 5s unit-test default under concurrent system load.
    // Keep a finite bound so genuine hangs still fail, while allowing normal
    // merge/rebase fixtures to complete on developer and CI hosts.
    testTimeout: 15_000,
    // Unbounded host-core parallelism makes subprocess-heavy git fixtures
    // contend until otherwise-healthy tests hit their timeout. Four workers
    // keeps throughput high while bounding process and filesystem pressure.
    maxWorkers: 4,
    // Polyfill browser globals that some renderer modules touch at import time
    // (localStorage in particular). Component tests opt into a full DOM via the
    // `// @vitest-environment jsdom` docblock; this setup only backfills the
    // storage shim jsdom does not provide a working implementation for here.
    setupFiles: ['src/test/setup-globals.ts'],
  },
})
