package session

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/testhome"
)

// A claude-code child whose permission rail cannot be set up is not started,
// and the dispatch reports why. Starting it anyway would run a CLI under
// bypassPermissions with nothing checking its tool calls.
func TestDispatch_DelegatedCliChildWithoutRailIsNotStarted(t *testing.T) {
	mgr := NewManager(newMockBackend())
	mgr.childBackendOverride = func() backend.RunBackend { return backend.NewClaudeCodeBackend() }
	if _, err := mgr.StartSession("rail-dispatch", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	// The rail's settings file is written to the temp dir; an unwritable one
	// makes the rail fail after the child's tool server is already up. Set
	// after the session exists, which resolves its own working directory.
	testhome.UnwritableTempDir(t)
	mgr.mu.Lock()
	s := mgr.sessions["rail-dispatch"]
	mgr.mu.Unlock()

	handler := mgr.buildAgentToolHandler(s, "rail-dispatch", "claude-opus-4-8")
	res, err := handler(context.Background(), map[string]interface{}{"prompt": "do the thing", "name": "worker", "wait_for_completion": true})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if !res.IsError {
		t.Fatalf("a child with no permission rail was dispatched: %s", res.Content)
	}
	if !strings.Contains(res.Content, "was not started") || !strings.Contains(res.Content, "permission rail") {
		t.Fatalf("the failure must say the child was not started and why, got %q", res.Content)
	}
}
