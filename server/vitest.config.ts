import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    globals: true,
    // Every worker gets a throwaway HOME so no test can touch
    // the operator's real ~/.ion (see the setup file for the leak it stops).
    setupFiles: ['src/test/setup-test-home.ts'],
    // Local-time output (steer dividers, stamps) must read the same on every
    // machine; CI runs in UTC.
    env: { TZ: 'UTC' },
  },
})
