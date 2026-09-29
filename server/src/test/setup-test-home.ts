// Test setup: isolate every Vitest worker from the operator's real ~/.ion.
//
// Server modules resolve durable state through `paths.ts`'s `dataDir()`,
// which is `ION_DATA_DIR` when set and `~/.ion` (via `os.homedir()`)
// otherwise. A store test that drives a real slice without mocking every
// persistence seam beneath it will therefore write the operator's actual
// registry: one did, and left a `/Users/test/project` row in
// `~/.ion/worktree-registry.json` that the running desktop then crawled --
// and warned about -- every five seconds. Pointing HOME (and USERPROFILE,
// which is what `os.homedir()` reads on Windows) at a throwaway directory
// per worker makes that class of leak impossible regardless of which seam a
// test forgets to mock. The desktop suite does the same in
// `src/test/setup-globals.ts`.
//
// HOME rather than ION_DATA_DIR on purpose: fixtures that build their own
// home (`bench-test-fixture.ts`, `bench-tool-policy.test.ts`) set HOME and
// expect `dataDir()` to follow it, which an explicit ION_DATA_DIR would
// override.
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { beforeAll } from 'vitest'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

function installTestHome(): void {
  const existing = process.env.ION_VITEST_HOME
  if (existing) {
    process.env.HOME = existing
    process.env.USERPROFILE = existing
    return
  }
  const realHome = homedir()
  const testHome = mkdtempSync(join(tmpdir(), 'ion-server-vitest-home-'))
  mkdirSync(join(testHome, '.ion'), { recursive: true })
  process.env.ION_REAL_HOME = realHome
  process.env.ION_VITEST_HOME = testHome
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome
  process.once('exit', () => rmSync(testHome, { recursive: true, force: true }))
}

installTestHome()

// The log file stays in the worker's home, whatever ION_DATA_DIR a test sets.
// Many tests point ION_DATA_DIR at a temp directory and delete it in
// afterEach; the logger's async append into that directory could land during
// the delete and fail it with ENOTEMPTY. Tests that assert on the log file
// call the logger's `_resetForTest()`, which clears this pin.
//
// In beforeAll, not at import: a static import here would load the logger
// (and everything it imports) before the test file's own vi.mock calls, so
// those mocks would miss it. By beforeAll the test file has loaded its
// modules, and this import returns the same instance, mocked or not. A mock
// without `configureLogger` writes nothing to disk, so it needs no pin.
beforeAll(async () => {
  const logger = await import('../logger')
  // A vi.mock module throws on reading an export it does not define, so ask
  // for the export list rather than reading the property.
  if (!Object.keys(logger).includes('configureLogger')) return
  logger.configureLogger({ dir: join(process.env.ION_VITEST_HOME as string, '.ion') })
})
