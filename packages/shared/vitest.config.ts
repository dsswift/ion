import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Matches co-located Foo.test.ts(x) files and the legacy __tests__/
    // directories carried over from the desktop/src/shared move (child 04).
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    globals: true,
  },
})
