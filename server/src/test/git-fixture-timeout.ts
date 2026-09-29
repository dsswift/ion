/**
 * Timeout for tests that drive a real git repository.
 *
 * Vitest's 5s default is calibrated for unit tests that touch nothing outside
 * the process. The worktree and bench suites are a different class: each one
 * builds a real repository in a temp dir and shells out to `git` dozens of
 * times (init, worktree add, commit, rebase, merge), so its wall-clock is
 * dominated by process spawns rather than by the code under test.
 *
 * That cost is machine-dependent in a way unit tests are not. The full suite
 * runs hundreds of files across parallel workers, and in a Linux container
 * (CI's `desktop-test` job and the `make test-linux` parity gate) the git
 * subprocesses contend for far less CPU per worker than on a developer's
 * machine. The operator-scenario test is the longest of these — roughly twice
 * the next-slowest — and it crossed the 5s default in the container while
 * finishing in about 1.5s locally, failing CI for a reason unrelated to the
 * behavior it asserts.
 *
 * The ceiling is deliberately far above the observed cost rather than trimmed
 * to fit it. Its job is to distinguish "slower than a unit test" from "hung",
 * and a bound set just over the local measurement would re-break on the next
 * slower machine. A genuine hang still fails here; it just fails on evidence
 * instead of on scheduling noise.
 *
 * Apply it per `describe` block, not globally: raising the default for every
 * test would hide real hangs in the pure-unit suites, where exceeding 5s is
 * always a defect.
 */
export const GIT_FIXTURE_TIMEOUT = 60_000
