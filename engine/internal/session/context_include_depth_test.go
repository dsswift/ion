package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// engine.json limits.contextIncludeMaxDepth reaches a run's options, which
// both the eager context walk and nested loading read. A value already on the
// options is kept.
func TestApplyConfigDefaults_ContextIncludeMaxDepth(t *testing.T) {
	depth := 2
	m := NewManager(newMockBackend())
	m.SetConfig(&types.EngineRuntimeConfig{Limits: types.LimitsConfig{ContextIncludeMaxDepth: &depth}})

	var opts types.RunOptions
	m.applyConfigDefaults(&opts)
	if opts.ContextIncludeMaxDepth != 2 {
		t.Fatalf("depth = %d, want 2 from engine config", opts.ContextIncludeMaxDepth)
	}

	opts = types.RunOptions{ContextIncludeMaxDepth: 7}
	m.applyConfigDefaults(&opts)
	if opts.ContextIncludeMaxDepth != 7 {
		t.Fatalf("depth = %d, a value already set must stand", opts.ContextIncludeMaxDepth)
	}
}
