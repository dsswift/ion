/**
 * `vitest.integration.config.ts`'s `setupFiles` entry -- runs before the test
 * file's own module graph is evaluated, in the same isolated environment.
 *
 * This matters because `server/src/logger.ts` resolves `dataDir()` into a
 * top-level `const LOG_DIR` ONCE, at first import, not lazily per call. Any
 * static import of server source (including transitively, e.g.
 * `server-engine.test.ts` -> `protocol/__tests__/harness.ts` -> `listener.ts`
 * -> `logger.ts`) evaluates that top-level `dataDir()` call the moment the
 * import graph loads -- which happens before a test file's own `beforeAll`
 * runs. Setting `ION_DATA_DIR` here, in a setup file guaranteed to run
 * first, is what keeps every server module this integration suite imports
 * from resolving `dataDir()` against the operator's real `~/.ion` (and
 * silently writing real `server.jsonl`/log-egress traffic there) instead of
 * this suite's disposable temp directory.
 *
 * SCOPED TO THIS CONFIG ONLY -- do not wire this into the default
 * `vitest.config.ts` (the fast unit suite). Several existing unit tests
 * (e.g. `src/worktree/__tests__/inventory-stage.test.ts`) deliberately
 * isolate by mocking `os.homedir()` per test/per file and rely on
 * `ION_DATA_DIR` staying UNSET so `dataDir()`'s fallback reaches their
 * mocked `homedir()`. A process-wide `ION_DATA_DIR` default set once here
 * would outrank every one of those per-test mocks (`dataDir()` checks
 * `ION_DATA_DIR` first) and silently break their isolation -- confirmed by
 * trying exactly that: `inventory-stage.test.ts` started leaking
 * `worktree-registry.json` state across tests the moment a shared
 * `ION_DATA_DIR` default was introduced process-wide. This integration
 * config's own test files never rely on a `homedir()` mock (they need a
 * REAL, on-disk directory the spawned engine binary can also see), so the
 * same fix is safe here and only here.
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

if (!process.env.ION_DATA_DIR) {
  process.env.ION_DATA_DIR = mkdtempSync(join(tmpdir(), 'ion-server-engine-it-'))
}
