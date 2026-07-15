package extcontext

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
)

// TestBuildDispatchRunOptionsThreadsClaudeCompat pins the ClaudeCompat
// threading fix: buildDispatchRunOptions must copy the caller-supplied compat
// flag onto the child RunOptions so the child's nested-descent context loader
// applies the same Ion-vs-Claude gate as the parent session. Before the fix,
// buildDispatchRunOptions took no compat parameter and RunOptions.ClaudeCompat
// was always false — this test would not compile against that signature and
// fails on the unfixed behavior.
func TestBuildDispatchRunOptionsThreadsClaudeCompat(t *testing.T) {
	opts := &extension.DispatchAgentOpts{
		Name: "child",
		Task: "do work",
	}

	t.Run("compat_enabled", func(t *testing.T) {
		runOpts := buildDispatchRunOptions(opts, "model-x", "/tmp/proj", context.Background(), true)
		if !runOpts.ClaudeCompat {
			t.Fatalf("expected RunOptions.ClaudeCompat=true when compat threaded in, got false")
		}
	})

	t.Run("compat_disabled", func(t *testing.T) {
		runOpts := buildDispatchRunOptions(opts, "model-x", "/tmp/proj", context.Background(), false)
		if runOpts.ClaudeCompat {
			t.Fatalf("expected RunOptions.ClaudeCompat=false when compat off, got true")
		}
	})
}
