package workspaces

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Process-wide workspace checker.
//
// ── Why one per process, not one per Manager or session ─────────────────────
// The checker reads the two workspace records under the ONE Ion home this
// process serves, and its cache is mtime-validated on every read. So sharing
// it is both safe — a worktree registered mid-session is visible to the very
// next tool call in every session — and what keeps the cost at a single stat
// per gated call instead of a cold re-parse per session.
//
// ── Why the accessor lives here and not in the session package ──────────────
// Containment is not the only consumer any more. Workspace CONTEXT and
// read-only ATTRIBUTION read the same two records, and they are reached from
// the tool registry and the prompt path, not from a Manager method. A
// singleton owned by one consumer forces every other consumer either to
// construct a second checker (a second cache, a second set of stats, and two
// views that can disagree within one tool call) or to reach through that
// consumer for no reason. Ownership belongs with the records.
//
// ── Why the override is a first-class seam, not a test-only hack ─────────────
// A package-level singleton is process state, and process state shared across
// tests is contamination: the first test to touch it pins the Ion home for
// every later test in the binary, and the failure surfaces as an unrelated
// test reading the developer's real ~/.ion. SetSharedCheckerForTest with its
// paired reset makes the lifetime explicit and per-test, so the singleton can
// be redirected without any test being able to leak it into the next one.
var (
	sharedMu      sync.Mutex
	sharedChecker *Checker
)

// SharedChecker returns the process-wide containment checker, constructing it
// on first use over the default Ion home (~/.ion).
//
// Safe for concurrent use: construction is guarded, and the returned Checker's
// own reads are internally locked.
func SharedChecker() *Checker {
	sharedMu.Lock()
	defer sharedMu.Unlock()
	if sharedChecker == nil {
		sharedChecker = NewChecker()
		utils.LogWithFields(utils.LevelInfo, logTag, "shared workspace checker created", map[string]any{
			"ion_dir": sharedChecker.reg.dir(),
		})
	}
	return sharedChecker
}

// SetSharedCheckerForTest redirects the process-wide checker and returns a
// function that restores the previous value.
//
// Register the restore with t.Cleanup so the override cannot outlive the test:
//
//	t.Cleanup(workspaces.SetSharedCheckerForTest(workspaces.NewCheckerAt(dir)))
//
// Passing nil resets to the lazily-constructed default, which is how a test
// asserts the un-overridden path without inheriting a previous test's
// redirection.
func SetSharedCheckerForTest(c *Checker) (restore func()) {
	sharedMu.Lock()
	previous := sharedChecker
	sharedChecker = c
	sharedMu.Unlock()

	return func() {
		sharedMu.Lock()
		sharedChecker = previous
		sharedMu.Unlock()
	}
}

// ResetSharedCheckerForTest drops the process-wide checker so the next
// SharedChecker call reconstructs it. Use when a test changed HOME and needs
// the default construction path to observe the new value.
func ResetSharedCheckerForTest() {
	sharedMu.Lock()
	sharedChecker = nil
	sharedMu.Unlock()
}
