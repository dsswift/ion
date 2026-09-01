package extcontext

import (
	"context"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// Regression test for a dispatched child's notify_on_complete Bash tasks never
// joining the owning session's outstanding set.
//
// The dispatch path set childCfg.BackgroundTaskOwner but neither
// RegisterOutstandingBackgroundTask nor OutstandingBackgroundTasks. A
// notify_on_complete Bash call needs BOTH: the owner attributes the task and
// kills it with the session, but the REGISTRAR is what puts it in the
// outstanding set, and that set is what the turn boundary reads to decide
// whether to park (ADR-023 § 2).
//
// The observable failure was a task that announced itself as notifying, was
// held by nothing, and never delivered. The engine logged "notify_on_complete
// task has no outstanding registrar; completion will notify but the session
// will not hold for it" and a client showed a monitoring state that no
// completion ever cleared -- work that appeared live while nothing ran.
//
// Reverting the fix (dropping the two childCfg assignments) turns this red:
// RunConfig arrives with nil seams.

// outstandingSeamProbeBackend implements configurableBackend, which is what
// startChild requires before it threads the RunConfig through. A backend
// without StartRunWithConfig silently degrades to plain StartRun and would
// observe no config at all.
type outstandingSeamProbeBackend struct {
	runOptsCapturingChildBackend
	cfgMu   sync.Mutex
	cfg     *backend.RunConfig
	onStart func(requestID string)
}

func (c *outstandingSeamProbeBackend) StartRunWithConfig(requestID string, opts types.RunOptions, cfg *backend.RunConfig) {
	c.cfgMu.Lock()
	c.cfg = cfg
	c.cfgMu.Unlock()
	c.StartRun(requestID, opts)
}

func (c *outstandingSeamProbeBackend) StartRun(requestID string, opts types.RunOptions) {
	c.mu.Lock()
	c.captured = opts
	c.started = true
	onExit := c.onExit
	c.mu.Unlock()
	if c.onStart != nil {
		c.onStart(requestID)
	}
	go func() {
		zero := 0
		if onExit != nil {
			onExit(requestID, &zero, nil, "outstanding-seam-conv")
		}
	}()
}

func (c *outstandingSeamProbeBackend) capturedRunConfig() *backend.RunConfig {
	c.cfgMu.Lock()
	defer c.cfgMu.Unlock()
	return c.cfg
}

// outstandingSeamAccessor implements the optional outstanding-task seam that
// the dispatch path discovers by type assertion, and records what the child
// registers through it.
type outstandingSeamAccessor struct {
	bumpCountingAccessor

	mu         sync.Mutex
	registered []string
	live       []string
	pollOwners []string
	// pollsByOwner mirrors the real session: polls are attributed to the run
	// that started them, and a run reads back only its own.
	pollsByOwner map[string][]string
}

func (a *outstandingSeamAccessor) RegisterOutstandingBackgroundTask(taskID, _ string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.registered = append(a.registered, taskID)
	a.live = append(a.live, taskID)
}

func (a *outstandingSeamAccessor) OutstandingBackgroundTaskIDs() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.live))
	copy(out, a.live)
	return out
}

func (a *outstandingSeamAccessor) StartPoll(_ context.Context, owner string, request tools.PollRequest, _ string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.pollOwners = append(a.pollOwners, owner)
	id := "poll-" + request.Intent
	a.pollsByOwner[owner] = append(a.pollsByOwner[owner], id)
	return id, nil
}

// OutstandingPollIDs answers per owner, the way the real session does.
func (a *outstandingSeamAccessor) OutstandingPollIDs(owner string) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.pollsByOwner[owner]))
	copy(out, a.pollsByOwner[owner])
	return out
}

func (a *outstandingSeamAccessor) recordedPollOwners() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.pollOwners))
	copy(out, a.pollOwners)
	return out
}

func (a *outstandingSeamAccessor) registeredIDs() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.registered))
	copy(out, a.registered)
	return out
}

// TestDispatchChildWiresOutstandingBackgroundTaskSeams asserts the child's
// RunConfig carries both seams, so a notify_on_complete Bash call from inside a
// dispatch can register with the owning session.
func TestDispatchChildWiresOutstandingBackgroundTaskSeams(t *testing.T) {
	child := &outstandingSeamProbeBackend{}
	accessor := &outstandingSeamAccessor{bumpCountingAccessor: bumpCountingAccessor{child: child}, pollsByOwner: map[string][]string{}}
	registry := NewDispatchRegistry()

	dispatch := BuildDispatchAgentFunc(accessor, registry, 0, "")
	if _, err := dispatch(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "outstanding-seam-probe",
		Task:              "start a background command",
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	cfg := child.capturedRunConfig()
	if cfg == nil {
		t.Fatal("child was never started with a RunConfig")
	}

	if cfg.BackgroundTaskOwner == "" {
		t.Error("BackgroundTaskOwner is empty: the child's tasks would not be attributed or killed with the session")
	}
	// The defect: the owner was set and these two were not.
	if cfg.RegisterOutstandingBackgroundTask == nil {
		t.Fatal("RegisterOutstandingBackgroundTask is nil: a notify_on_complete Bash task from this dispatch would never join the outstanding set, so the session would never hold for it")
	}
	if cfg.OutstandingBackgroundTasks == nil {
		t.Fatal("OutstandingBackgroundTasks is nil: the turn boundary could not see the child's tasks and would complete while they were still running")
	}

	// The registrar must reach the OWNING SESSION's set, not a child-local one.
	// A child-scoped set would be discarded when the dispatch ended -- the same
	// run-scoped mistake ADR-023 § 2 rejects for the root.
	cfg.RegisterOutstandingBackgroundTask("bash-1-outstanding", "sleep 30")

	got := accessor.registeredIDs()
	if len(got) != 1 || got[0] != "bash-1-outstanding" {
		t.Fatalf("registrar did not reach the owning session: got %v", got)
	}

	// And the reader must observe it, which is what makes the park decision see
	// live work rather than an empty set.
	live := cfg.OutstandingBackgroundTasks()
	if len(live) != 1 || live[0] != "bash-1-outstanding" {
		t.Errorf("OutstandingBackgroundTasks did not report the registered task: got %v", live)
	}
}

// TestDispatchChildWiresPollSeams is the same defect class as the background-task
// seams above: the dispatch path built a child RunConfig without them.
//
// Without PollStarter the Poll tool refused outright inside a dispatch, so a
// dispatched agent could not watch external state and had to fall back to a
// sleep loop -- the exact anti-pattern Poll exists to replace. Without
// OutstandingPolls a running poll is invisible to the turn boundary, so the
// session completes while the poll still holds work open.
func TestDispatchChildWiresPollSeams(t *testing.T) {
	child := &outstandingSeamProbeBackend{}
	accessor := &outstandingSeamAccessor{bumpCountingAccessor: bumpCountingAccessor{child: child}, pollsByOwner: map[string][]string{}}
	registry := NewDispatchRegistry()

	dispatch := BuildDispatchAgentFunc(accessor, registry, 0, "")
	if _, err := dispatch(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "poll-seam-probe",
		Model:             "child-model",
		Task:              "watch external state",
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	cfg := child.capturedRunConfig()
	if cfg == nil {
		t.Fatal("child was never started with a RunConfig")
	}
	if cfg.PollStarter == nil {
		t.Fatal("PollStarter is nil: the Poll tool would answer \"unavailable outside a session-owned engine run\" inside every dispatch")
	}
	if cfg.OutstandingPolls == nil {
		t.Fatal("OutstandingPolls is nil: a running poll would be invisible to the turn boundary and the session would complete under it")
	}

	id, err := cfg.PollStarter(context.Background(), tools.PollRequest{Intent: "probe"}, "/tmp")
	if err != nil {
		t.Fatalf("PollStarter: %v", err)
	}
	if id != "poll-probe" {
		t.Errorf("poll did not reach the owning session: got %q", id)
	}

	if live := cfg.OutstandingPolls(); len(live) != 1 || live[0] != "poll-probe" {
		t.Errorf("OutstandingPolls did not report the started poll: got %v", live)
	}

	// The poll must be attributed to THIS dispatch, not left unowned. An empty
	// owner would put it in the root's park set instead.
	owners := accessor.recordedPollOwners()
	if len(owners) != 1 || owners[0] == "" {
		t.Fatalf("poll was not attributed to the dispatch that started it: got %v", owners)
	}

	// The deadlock guard. Poll resolves its intent by dispatching a poll-check
	// child, which is another run in the same session. That child must NOT see
	// this dispatch's poll in its own park set -- if it does, it parks on the
	// very poll it was dispatched to resolve, the poll never finishes, and the
	// full deadline burns before returning "stuck".
	//
	// A session-wide reader (the original defect) returns the poll here.
	if sibling := accessor.OutstandingPollIDs("some-other-dispatch"); len(sibling) != 0 {
		t.Errorf("a sibling run sees another dispatch's poll (%v): a poll-check child would park on the poll it exists to resolve", sibling)
	}
}
