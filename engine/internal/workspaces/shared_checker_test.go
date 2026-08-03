package workspaces

// The process-wide checker accessor and its test seam.
//
// A package-level singleton is process state, and process state shared across
// tests is contamination: the first test to touch it would pin the Ion home for
// every later test in the binary. These tests pin that the override is
// per-test-scoped and always restorable, which is the property that makes the
// singleton safe to have at all.

import (
	"path/filepath"
	"sync"
	"testing"
)

func TestSharedCheckerReturnsTheSameInstance(t *testing.T) {
	// Redirect first so the default construction path never reads the
	// developer's real ~/.ion during this test.
	dir := t.TempDir()
	t.Cleanup(SetSharedCheckerForTest(NewCheckerAt(dir)))

	first, second := SharedChecker(), SharedChecker()

	if first != second {
		t.Fatal("the shared checker must be one instance; two would mean two caches that can disagree within a tool call")
	}
}

func TestSharedCheckerOverrideIsRestored(t *testing.T) {
	outer := NewCheckerAt(t.TempDir())
	t.Cleanup(SetSharedCheckerForTest(outer))

	inner := NewCheckerAt(t.TempDir())
	restore := SetSharedCheckerForTest(inner)
	if SharedChecker() != inner {
		t.Fatal("the override must take effect immediately")
	}

	restore()
	if SharedChecker() != outer {
		t.Fatal("restoring must return the PREVIOUS value, not the lazily-constructed default; otherwise a nested override leaks")
	}
}

// The override must actually redirect what the checker READS, not merely which
// pointer is returned — a redirect that shares the real Ion home would still
// contaminate.
func TestSharedCheckerOverrideRedirectsRecordReads(t *testing.T) {
	dir := t.TempDir()
	writeWorktreeRegistry(t, dir, []WorktreeEntry{{WorktreePath: minePath, RepoPath: repoPath}})
	t.Cleanup(SetSharedCheckerForTest(NewCheckerAt(dir)))

	r := SharedChecker().Check("Write", writeInput(filepath.Join(repoPath, "x.go")), minePath)

	if r == nil || r.Kind != RefusalBaseRepo {
		t.Fatalf("the override's records must be the ones consulted, got %+v", r)
	}
}

// A nil override resets to the lazily-constructed default, which is how a test
// asserts the un-overridden path without inheriting a previous redirection.
func TestSharedCheckerResetReconstructs(t *testing.T) {
	first := NewCheckerAt(t.TempDir())
	t.Cleanup(SetSharedCheckerForTest(first))

	ResetSharedCheckerForTest()
	rebuilt := SharedChecker()

	if rebuilt == nil {
		t.Fatal("reset must allow reconstruction, not leave a nil checker")
	}
	if rebuilt == first {
		t.Fatal("reset must construct a fresh checker, not return the discarded one")
	}
}

// Construction is guarded, so concurrent first-use cannot produce two instances
// (two caches, two stat costs, and two views that can disagree).
func TestSharedCheckerIsSafeForConcurrentFirstUse(t *testing.T) {
	t.Cleanup(SetSharedCheckerForTest(nil))
	ResetSharedCheckerForTest()

	const goroutines = 24
	var wg sync.WaitGroup
	seen := make([]*Checker, goroutines)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			seen[idx] = SharedChecker()
		}(i)
	}
	wg.Wait()

	for i, c := range seen {
		if c != seen[0] {
			t.Fatalf("goroutine %d saw a different instance; construction is not guarded", i)
		}
	}
}
