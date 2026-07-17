package extcontext

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
)

// TestBuildDispatchRunOptionsThreadsImplementationPhase pins the
// DispatchAgentOpts.ImplementationPhase → RunOptions.ImplementationPhase
// threading. Before the fix, the dispatch path had no way to reach the
// RunOptions field: an "implement the approved plan" dispatch still got the
// EnterPlanMode sentinel injected (runloop_setup.go), and children stalled by
// proposing plan mode mid-implementation — harnesses fought it with brittle
// "Do NOT call EnterPlanMode" prompt text, the exact mechanism the RunOptions
// field was added to replace. This test fails on the unfixed code (flag
// silently dropped).
func TestBuildDispatchRunOptionsThreadsImplementationPhase(t *testing.T) {
	t.Run("set", func(t *testing.T) {
		opts := &extension.DispatchAgentOpts{
			Name:                "child",
			Task:                "implement the approved plan",
			ImplementationPhase: true,
		}
		runOpts := buildDispatchRunOptions(opts, "model-x", "/tmp/proj", context.Background(), false, noopSA{})
		if !runOpts.ImplementationPhase {
			t.Fatal("expected RunOptions.ImplementationPhase=true when dispatch opts set it, got false")
		}
	})

	t.Run("unset_default", func(t *testing.T) {
		opts := &extension.DispatchAgentOpts{Name: "child", Task: "investigate"}
		runOpts := buildDispatchRunOptions(opts, "model-x", "/tmp/proj", context.Background(), false, noopSA{})
		if runOpts.ImplementationPhase {
			t.Fatal("expected RunOptions.ImplementationPhase=false by default, got true")
		}
	})
}

// TestBuildDispatchRunOptionsThreadsSuppressTools pins the
// DispatchAgentOpts.SuppressTools → RunOptions.SuppressTools threading.
// Canonical consumer: a harness suppresses the engine's built-in Agent tool
// in dispatched children so child delegation must route through the
// harness's own dispatch tool (tier resolution + allowlists) instead of the
// ungoverned built-in spawner. This test fails on the unfixed code (list
// silently dropped).
func TestBuildDispatchRunOptionsThreadsSuppressTools(t *testing.T) {
	t.Run("set", func(t *testing.T) {
		opts := &extension.DispatchAgentOpts{
			Name:          "child",
			Task:          "do work",
			SuppressTools: []string{"Agent"},
		}
		runOpts := buildDispatchRunOptions(opts, "model-x", "/tmp/proj", context.Background(), false, noopSA{})
		if len(runOpts.SuppressTools) != 1 || runOpts.SuppressTools[0] != "Agent" {
			t.Fatalf("expected RunOptions.SuppressTools=[Agent], got %v", runOpts.SuppressTools)
		}
	})

	t.Run("unset_default", func(t *testing.T) {
		opts := &extension.DispatchAgentOpts{Name: "child", Task: "do work"}
		runOpts := buildDispatchRunOptions(opts, "model-x", "/tmp/proj", context.Background(), false, noopSA{})
		if len(runOpts.SuppressTools) != 0 {
			t.Fatalf("expected empty RunOptions.SuppressTools by default, got %v", runOpts.SuppressTools)
		}
	})
}
