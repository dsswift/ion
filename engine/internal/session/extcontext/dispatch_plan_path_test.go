package extcontext

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// runOptsCapturingChildBackend is a mock RunBackend that captures the
// types.RunOptions handed to StartRun, then exits cleanly. It lets a test
// assert what the dispatch assembly produced for the child run — in
// particular, the PlanFilePath the plan-mode allocation path populated.
type runOptsCapturingChildBackend struct {
	mu       sync.Mutex
	onNorm   func(runID string, event types.NormalizedEvent)
	onExit   func(runID string, code *int, signal *string, sessionID string)
	onErr    func(runID string, err error)
	captured types.RunOptions
	started  bool
}

func (c *runOptsCapturingChildBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	c.mu.Lock()
	c.onNorm = fn
	c.mu.Unlock()
}
func (c *runOptsCapturingChildBackend) OnExit(fn func(string, *int, *string, string)) {
	c.mu.Lock()
	c.onExit = fn
	c.mu.Unlock()
}
func (c *runOptsCapturingChildBackend) OnError(fn func(string, error)) {
	c.mu.Lock()
	c.onErr = fn
	c.mu.Unlock()
}
func (c *runOptsCapturingChildBackend) Cancel(string) bool                     { return false }
func (c *runOptsCapturingChildBackend) IsRunning(string) bool                  { return false }
func (c *runOptsCapturingChildBackend) WriteToStdin(string, interface{}) error { return nil }
func (c *runOptsCapturingChildBackend) FlushConversations()                    {}

func (c *runOptsCapturingChildBackend) StartRun(requestID string, opts types.RunOptions) {
	c.mu.Lock()
	c.captured = opts
	c.started = true
	onNorm, onExit := c.onNorm, c.onExit
	c.mu.Unlock()

	go func() {
		time.Sleep(5 * time.Millisecond)
		if onNorm != nil {
			onNorm(requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{Result: "done"}})
		}
		if onExit != nil {
			zero := 0
			onExit(requestID, &zero, nil, "plan-path-conv")
		}
	}()
}

func (c *runOptsCapturingChildBackend) capturedOpts() types.RunOptions {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.captured
}

// TestDispatchPlanMode_AllocatesPlanFilePath is the regression test for
// Defect 1: a planMode:true dispatch that supplies NO PlanFilePath must have a
// fresh plan-file path allocated for the child run, exactly as the root paths
// (RequestPlanModeEnter, SendPrompt) do. Before the fix, the dispatch assembly
// left RunOptions.PlanFilePath == "" — the child ran with PlanMode=true and an
// empty path, and the plan-mode write guard rejected every write with
// "Only the plan file () is writable". This test fails (empty PlanFilePath) on
// the unfixed code.
func TestDispatchPlanMode_AllocatesPlanFilePath(t *testing.T) {
	const allocated = "/tmp/.ion/plans/brave-gliding-otter.md"

	child := &runOptsCapturingChildBackend{}
	acc := &bumpCountingAccessor{child: child, allocPlanPath: allocated}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	_, err := dispatchFn(extension.DispatchAgentOpts{
		Name:     "plan-lead",
		Task:     "plan the work",
		PlanMode: true,
		// PlanFilePath intentionally left empty — the normal dispatch case.
	})
	if err != nil {
		t.Fatalf("dispatch returned error: %v", err)
	}

	got := child.capturedOpts()

	// Assertion 1: the child run received a NON-EMPTY plan-file path. On the
	// unfixed code this is "" → red.
	if got.PlanFilePath == "" {
		t.Fatal("child RunOptions.PlanFilePath is empty; plan-mode dispatch did not allocate a plan file path")
	}
	// The allocated path must be plan-shaped: inside a .ion/plans directory with
	// a .md filename.
	if !strings.Contains(got.PlanFilePath, "/.ion/plans/") || !strings.HasSuffix(got.PlanFilePath, ".md") {
		t.Errorf("PlanFilePath = %q, want a .ion/plans/<slug>.md-shaped path", got.PlanFilePath)
	}
	if got.PlanFilePath != allocated {
		t.Errorf("PlanFilePath = %q, want the allocated path %q", got.PlanFilePath, allocated)
	}

	// Assertion 2: PlanMode must still be true — guard against a "fix" that
	// silently disables plan mode to dodge the empty-path guard.
	if !got.PlanMode {
		t.Error("child RunOptions.PlanMode = false, want true (plan mode must be preserved, not disabled)")
	}
}

// TestDispatchPlanMode_RespectsExplicitPlanFilePath verifies the allocation
// only fires when no path was supplied: a dispatch that DOES carry an explicit
// PlanFilePath keeps it verbatim (no re-allocation). This pins that the fix is
// scoped to the empty-path case and does not clobber a caller-chosen path.
func TestDispatchPlanMode_RespectsExplicitPlanFilePath(t *testing.T) {
	const explicit = "/custom/place/my-plan.md"

	child := &runOptsCapturingChildBackend{}
	// allocPlanPath differs from explicit so a wrongful re-allocation is caught.
	acc := &bumpCountingAccessor{child: child, allocPlanPath: "/tmp/.ion/plans/should-not-be-used.md"}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	_, err := dispatchFn(extension.DispatchAgentOpts{
		Name:         "plan-lead",
		Task:         "plan the work",
		PlanMode:     true,
		PlanFilePath: explicit,
	})
	if err != nil {
		t.Fatalf("dispatch returned error: %v", err)
	}

	got := child.capturedOpts()
	if got.PlanFilePath != explicit {
		t.Errorf("PlanFilePath = %q, want the explicit path %q (must not re-allocate)", got.PlanFilePath, explicit)
	}
	if !got.PlanMode {
		t.Error("child RunOptions.PlanMode = false, want true")
	}
}

// TestDispatchNoPlanMode_NoPlanFilePath verifies a non-plan-mode dispatch never
// gets a plan-file path allocated (the allocation is gated on opts.PlanMode).
func TestDispatchNoPlanMode_NoPlanFilePath(t *testing.T) {
	child := &runOptsCapturingChildBackend{}
	acc := &bumpCountingAccessor{child: child, allocPlanPath: "/tmp/.ion/plans/should-not-be-used.md"}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")

	_, err := dispatchFn(extension.DispatchAgentOpts{
		Name: "worker",
		Task: "just work",
	})
	if err != nil {
		t.Fatalf("dispatch returned error: %v", err)
	}

	got := child.capturedOpts()
	if got.PlanFilePath != "" {
		t.Errorf("PlanFilePath = %q, want empty for a non-plan-mode dispatch", got.PlanFilePath)
	}
	if got.PlanMode {
		t.Error("child RunOptions.PlanMode = true, want false for a non-plan-mode dispatch")
	}
}
