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
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
    globals: true,
    // Polyfill browser globals that some renderer modules touch at import time
    // (localStorage in particular). Component tests opt into a full DOM via the
    // `// @vitest-environment jsdom` docblock; this setup only backfills the
    // storage shim jsdom does not provide a working implementation for here.
    setupFiles: ['src/test/setup-globals.ts'],
  },
})
