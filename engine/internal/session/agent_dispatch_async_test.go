package session

import (
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
)

// TestRootAgentDispatch_DefaultReturnsBeforeChildCompletes proves the user-
// visible contract: Agent dispatch does not hold the orchestrator tool call.
// The terminal result is then injected as a classified fresh prompt, so an
// idle conversation resumes without an extension callback.
func TestRootAgentDispatch_DefaultReturnsBeforeChildCompletes(t *testing.T) {
	stub := &childStubBackend{resultText: "child finished", releaseGate: make(chan struct{})}
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.childBackendOverride = func() backend.RunBackend { return stub }

	const key = "async-root-dispatch"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.RLock()
	s := mgr.sessions[key]
	mgr.mu.RUnlock()

	spawner := mgr.buildRootAgentSpawner(s, key, "claude-sonnet", nil)
	returned := make(chan string, 1)
	go func() {
		out, err := spawner(s.rootContext(), "", "finish later", "", "/tmp", "")
		if err != nil {
			returned <- "error: " + err.Error()
			return
		}
		returned <- out
	}()

	select {
	case out := <-returned:
		if out == "" || out == "child finished" {
			t.Fatalf("default spawner result = %q, want immediate dispatch acknowledgement", out)
		}
	case <-time.After(time.Second):
		t.Fatal("default Agent dispatch blocked on child completion")
	}

	close(stub.releaseGate)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mb.mu.Lock()
		count := len(mb.startOrder)
		var optsText string
		if count > 0 {
			optsText = mb.started[mb.startOrder[0]].Prompt
		}
		mb.mu.Unlock()
		if count == 1 && optsText != "" {
			if optsText == "finish later" {
				t.Fatal("completion delivery replayed original child task instead of terminal result")
			}
			for _, want := range []string{"[Agent agent-1 completed]", "Dispatch ID:", "child finished"} {
				if !strings.Contains(optsText, want) {
					t.Fatalf("completion delivery %q is missing %q", optsText, want)
				}
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("root child completion did not start a delivery run")
}
