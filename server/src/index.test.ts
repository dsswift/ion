import { describe, expect, it } from 'vitest'

// Scaffold placeholder pinning that `@ion/server` is a loadable, tested
// workspace package (child 04 of the Ion Studio Server program). The real
// boot sequence, HostApi, and readiness surface land in child 06; this test
// only proves the module graph resolves and the workspace test lane runs.
describe('@ion/server scaffold', () => {
  it('loads without throwing', async () => {
    await expect(import('./index.js')).resolves.toBeDefined()
  })
})
