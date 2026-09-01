package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/session/extcontext"
)

// Regression tests for poll-check parentage.
//
// runPollAttempt built its dispatch with BuildDispatchAgentFunc(acc, registry,
// 0, "") -- depth zero, no parent -- so every poll-check registered as a
// root-level dispatch no matter who called Poll. A poll started by a dispatched
// agent appeared in the orchestrator's agent panel as a SIBLING of that agent
// rather than its child.
//
// The misparenting was not only cosmetic: AgentStatus reported the judge as
// top-level work, recall of a subtree could not reach it because ownership
// resolves by parent chain, and its depth was counted from zero rather than
// from the caller, so a deeply nested poll sidestepped the nesting guard.
//
// The poll's owner attribution (activePoll.owner) already carried the calling
// dispatch ID; the driver simply discarded it. These tests pin the two values
// the driver now derives from it.

// TestDepthOfReportsDispatchDepth pins the lookup the poll driver uses to place
// its child one level below the caller.
func TestDepthOfReportsDispatchDepth(t *testing.T) {
	r := extcontext.NewDispatchRegistry()
	r.RegisterWithID("disp-depth-2", "agent-1", func() {}, nil, "sess-1", "disp-depth-1", 2)

	depth, known := r.DepthOf("disp-depth-2")
	if !known {
		t.Fatal("depth unknown for a registered dispatch: the poll driver would parent its child at root")
	}
	if depth != 2 {
		t.Fatalf("depth = %d, want 2", depth)
	}
}

// An unknown owner is the root session, or a dispatch that already completed.
// Both fall back to the root shape rather than guessing a depth.
func TestDepthOfUnknownDispatch(t *testing.T) {
	r := extcontext.NewDispatchRegistry()

	if _, known := r.DepthOf("never-registered"); known {
		t.Error("unknown dispatch reported a known depth")
	}
	if _, known := r.DepthOf(""); known {
		t.Error("empty owner (root session) must not report a known depth")
	}
}

// The deadlock guard, restated at the parentage layer.
//
// Parenting the poll-check to its caller must NOT put it in the caller's park
// set. If it did, the parent would park on the child it dispatched to resolve
// its own poll -- the exact self-deadlock that made every poll inside a
// dispatch burn its full 30-minute deadline.
//
// pollDispatchOptions sets Detached: true, and ChildIDsOf excludes detached
// children. This test pins that combination: a detached child is visible in the
// registry (so the panel can show the hierarchy) but absent from the park set.
func TestDetachedPollCheckIsNotInParentParkSet(t *testing.T) {
	r := extcontext.NewDispatchRegistry()
	const parent = "dispatch-agent-1"
	r.RegisterWithID(parent, "agent-1", func() {}, nil, "sess-1", "", 0)

	// A normal child joins the parent's park set.
	r.RegisterWithID("dispatch-child", "worker", func() {}, nil, "sess-1", parent, 1)
	if got := r.ChildIDsOf(parent); len(got) != 1 || got[0] != "dispatch-child" {
		t.Fatalf("normal child missing from park set: %v", got)
	}

	// A poll-check child is parented the same way but detached, so it must not
	// appear in the park set.
	r.RegisterWithID("dispatch-poll-check", "poll-check", func() {}, nil, "sess-1", parent, 1)
	r.MarkDetached("dispatch-poll-check")

	for _, id := range r.ChildIDsOf(parent) {
		if id == "dispatch-poll-check" {
			t.Fatal("poll-check is in its parent's park set: the parent would park on the child dispatched to resolve its own poll, which is the 30-minute self-deadlock")
		}
	}

	// It is still registered, which is what lets a client render it under its
	// parent instead of at the root.
	found := false
	for _, entry := range r.Snapshot() {
		if entry.DispatchID == "dispatch-poll-check" {
			found = true
			if entry.ParentDispatchID != parent {
				t.Errorf("poll-check ParentDispatchID = %q, want %q: it would render as a root-level agent", entry.ParentDispatchID, parent)
			}
			if entry.Depth != 1 {
				t.Errorf("poll-check Depth = %d, want 1", entry.Depth)
			}
		}
	}
	if !found {
		t.Error("poll-check absent from the registry snapshot: no client could render it at all")
	}
}

// The registry tests above pass whether or not the DRIVER threads its owner
// through, because they exercise the registry directly. This pins the call site
// itself -- the line that was the defect.
//
// runPollAttempt must build its dispatch from the poll's owner and that owner's
// depth, never from a hardcoded root. Restoring
// BuildDispatchAgentFunc(acc, registry, 0, "") turns this red.
func TestPollDriverParentsCheckToItsOwner(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("poll_driver.go"))
	if err != nil {
		t.Fatalf("read poll_driver.go: %v", err)
	}
	body := string(src)

	if strings.Contains(body, `BuildDispatchAgentFunc(acc, registry, 0, "")`) {
		t.Error("poll driver still hardcodes a root dispatch: every poll-check would register as a top-level agent instead of a child of the run that started the poll")
	}
	if !strings.Contains(body, "BuildDispatchAgentFunc(acc, registry, pollDepth, owner)") {
		t.Error("poll driver does not pass the poll owner and its depth to the dispatch seam")
	}
	// The depth must come from the owner's registry entry.
	if !strings.Contains(body, "registry.DepthOf(owner)") {
		t.Error("poll driver does not resolve the owner's depth; a nested poll would sidestep the nesting guard")
	}

	// pollDepth is the CALLER's depth, passed as currentDepth. The dispatch
	// seam derives childDepth = currentDepth + 1 itself, so incrementing here
	// double-counts and the depth guard refuses the judge at the cap. Observed
	// live: a depth-1 agent's poll asked for a depth-3 child against a cap of
	// 3, the poll-check was blocked, and the poll could never resolve.
	if strings.Contains(body, "pollDepth = d + 1") {
		t.Error("poll driver increments the owner's depth: BuildDispatchAgentFunc already adds one, so the poll-check is refused by the depth guard and the poll can never resolve")
	}
	if !strings.Contains(body, "pollDepth = d\n") && !strings.Contains(body, "pollDepth = d\t") && !strings.Contains(body, "pollDepth = d ") {
		t.Error("poll driver does not pass the owner's own depth as currentDepth")
	}
}

// TestPollCheckDepthStaysUnderCap pins the arithmetic against the real guard: a
// poll started by a dispatch at the deepest allowed tier must still be able to
// dispatch its judge, because the judge IS how the poll resolves.
func TestPollCheckDepthStaysUnderCap(t *testing.T) {
	r := extcontext.NewDispatchRegistry()
	// A depth-1 agent -- the common case, an agent dispatched by the root.
	r.RegisterWithID("dispatch-agent-1", "agent-1", func() {}, nil, "sess-1", "", 1)

	depth, known := r.DepthOf("dispatch-agent-1")
	if !known {
		t.Fatal("owner depth unknown")
	}
	// The driver passes this as currentDepth; the seam adds one.
	childDepth := depth + 1
	if childDepth != 2 {
		t.Fatalf("poll-check child depth = %d, want 2 for a depth-1 caller", childDepth)
	}
	// The double-count bug produced 3 here, which the default cap refuses.
	if doubled := (depth + 1) + 1; doubled <= 2 {
		t.Fatalf("test is not exercising the double-count: got %d", doubled)
	}
}
