import { rmSync } from 'node:fs'

/**
 * Remove a temporary repository after a real-Git test.
 *
 * Linux can briefly report ENOTEMPTY while Git finishes directory metadata
 * updates. Node retries that transient class only when maxRetries is non-zero;
 * plain recursive removal therefore makes otherwise-passing suites flaky.
 */
export function removeGitFixture(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}
