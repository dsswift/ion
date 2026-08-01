/**
 * Wrap an async runner so invocations that arrive while one is still running
 * are DROPPED rather than queued.
 *
 * Built for poll loops over expensive fetches: a `setInterval` fires on the
 * clock regardless of whether the previous tick finished, so under load the
 * un-guarded version stacks a new fetch behind every slow one — the compounding
 * that let overlapping worktree-inventory crawls freeze the main process.
 * Dropping is correct for refresh-shaped work because every invocation asks
 * for the same thing ("the current state"); the next tick re-asks.
 *
 * The gate reopens on settle regardless of outcome — a rejected run must not
 * jam the loop shut forever. Rejections are swallowed here by design: refresh
 * runners are expected to do their own error logging (both store refresh
 * actions do), and a poll wrapper re-reporting them would double-log.
 */
export function singleFlight(run: () => Promise<unknown>): () => void {
  let inFlight = false
  return () => {
    if (inFlight) return
    inFlight = true
    run().then(
      () => { inFlight = false },
      () => { inFlight = false },
    )
  }
}
