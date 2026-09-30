//go:build integration

package integration

import (
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// The dispatch control plane against real parent and child session wiring:
// list, steer, recall, and terminal history resolve one canonical dispatch ID
// under one ownership rule, at every depth, across completion races and
// across a session or engine restart.

const controlPlaneTimeout = 15 * time.Second

// controlPlane drives one manager session with a mock provider. Dispatches
// are detached so the test controls each one's life explicitly.
type controlPlane struct {
	t    *testing.T
	mp   *helpers.MockProvider
	mgr  *session.Manager
	key  string
	root *extension.Context

	mu    sync.Mutex
	ended map[string]chan struct{} // dispatch label -> closed on any terminal callback
}

func newControlPlaneProvider(t *testing.T) *helpers.MockProvider {
	t.Helper()
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })
	mp := helpers.NewMockProvider("mock")
	providers.RegisterProvider(mp)
	providers.RegisterModel("mock-model", types.ModelInfo{ProviderID: "mock", ContextWindow: 200000})
	return mp
}

func newControlPlane(t *testing.T, mp *helpers.MockProvider, mgr *session.Manager, key, conversationID string) *controlPlane {
	t.Helper()
	cfg := types.EngineConfig{ProfileID: key, WorkingDirectory: t.TempDir(), SessionID: conversationID}
	if _, err := mgr.StartSession(key, cfg); err != nil {
		t.Fatalf("StartSession(%s): %v", key, err)
	}
	host := extension.NewHost()
	group := extension.NewExtensionGroup()
	group.Add(host)
	mgr.TestSetExtGroup(key, group)
	root := mgr.TestNewExtContext(key)
	if root == nil {
		t.Fatalf("TestNewExtContext(%s) returned nil", key)
	}
	return &controlPlane{t: t, mp: mp, mgr: mgr, key: key, root: root, ended: map[string]chan struct{}{}}
}

// ctxFor is the extension context a dispatched agent gets: its own dispatch
// ID and depth, on the session's registry.
func (cp *controlPlane) ctxFor(dispatchID string, depth int) *extension.Context {
	return cp.mgr.TestNewExtContextWithOpts(cp.key, extcontext.ExtContextOpts{Depth: depth, DispatchId: dispatchID})
}

// dispatch starts a detached dispatch of agent name from ctx, labelled by
// its name for waitEnded.
func (cp *controlPlane) dispatch(ctx *extension.Context, name string) string {
	cp.t.Helper()
	return cp.dispatchAs(ctx, name, name)
}

// dispatchAs starts a detached dispatch of agent name from ctx and waits until
// its run has reached the provider. label keys waitEnded and must be unique
// per controlPlane; name need not be.
func (cp *controlPlane) dispatchAs(ctx *extension.Context, label, name string) string {
	cp.t.Helper()
	ended := make(chan struct{})
	var once sync.Once
	end := func() { once.Do(func() { close(ended) }) }
	cp.mu.Lock()
	cp.ended[label] = ended
	cp.mu.Unlock()

	calls := cp.mp.CallCount()
	stub, err := ctx.DispatchAgent(extension.DispatchAgentOpts{
		Name: name, Task: "task-" + name, Model: "mock-model", MaxTurns: 1, Detached: true,
		OnComplete: func(extension.DispatchAgentResult) { end() },
		OnError:    func(extension.DispatchError) { end() },
		OnRecall:   func(extension.RecallInfo) { end() },
	})
	if err != nil {
		cp.t.Fatalf("dispatch %s: %v", name, err)
	}
	deadline := time.Now().Add(controlPlaneTimeout)
	for cp.mp.CallCount() <= calls {
		if time.Now().After(deadline) {
			cp.t.Fatalf("dispatch %s never reached the provider", name)
		}
		time.Sleep(10 * time.Millisecond)
	}
	return stub.DispatchID
}

func (cp *controlPlane) waitEnded(label string) {
	cp.t.Helper()
	cp.mu.Lock()
	ended := cp.ended[label]
	cp.mu.Unlock()
	select {
	case <-ended:
	case <-time.After(controlPlaneTimeout):
		cp.t.Fatalf("dispatch %s never ended", label)
	}
}

// waitSteerable polls until a steer to id is accepted: the child's run ID is
// recorded a moment after the provider call starts.
func (cp *controlPlane) waitSteerable(ctx *extension.Context, id string) {
	cp.t.Helper()
	deadline := time.Now().Add(controlPlaneTimeout)
	for {
		res, err := ctx.SteerDispatch(id, "warm-up")
		if err != nil {
			cp.t.Fatalf("SteerDispatch(%s): %v", id, err)
		}
		if res.Outcome == "delivered" || res.Outcome == "channel_full" {
			return
		}
		if time.Now().After(deadline) {
			cp.t.Fatalf("dispatch %s never became steerable (last outcome %q)", id, res.Outcome)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func findDispatch(t *testing.T, ctx *extension.Context, id string) (extension.DispatchStateEntry, bool) {
	t.Helper()
	entries, err := ctx.ListDispatchState()
	if err != nil {
		t.Fatalf("ListDispatchState: %v", err)
	}
	for _, e := range entries {
		if e.DispatchID == id {
			return e, true
		}
	}
	return extension.DispatchStateEntry{}, false
}

func historyByID(t *testing.T, ctx *extension.Context) map[string]extension.DispatchHistoryEntry {
	t.Helper()
	entries, err := ctx.ListDispatchHistory()
	if err != nil {
		t.Fatalf("ListDispatchHistory: %v", err)
	}
	out := make(map[string]extension.DispatchHistoryEntry, len(entries))
	for _, e := range entries {
		out[e.DispatchID] = e
	}
	return out
}

func steer(t *testing.T, ctx *extension.Context, id string) extension.SteerDispatchResult {
	t.Helper()
	res, err := ctx.SteerDispatch(id, "steer")
	if err != nil {
		t.Fatalf("SteerDispatch(%s): %v", id, err)
	}
	return res
}

// TestDispatchControlPlane_LiveIdentityAndAuthorization covers the live half
// of the matrix: one canonical ID through list, steer, and recall at depth 1
// and 2; unique and ambiguous names; the ownership rule for parent, root,
// self, ancestor, sibling, and an unrelated session; and a steer that races
// its target's completion.
func TestDispatchControlPlane_LiveIdentityAndAuthorization(t *testing.T) {
	mp := newControlPlaneProvider(t)
	mp.SetBlockUntilCancel(true)
	mgr := session.NewManager(backend.NewApiBackend())
	cp := newControlPlane(t, mp, mgr, "cp-live", "")
	t.Cleanup(func() { mgr.StopSession("cp-live") })

	//   lead (A) -> coder (A1)       peer (B) -> coder (B1)
	idA := cp.dispatch(cp.root, "lead")
	leadCtx := cp.ctxFor(idA, 1)
	idA1 := cp.dispatch(leadCtx, "coder-a")
	idB := cp.dispatch(cp.root, "peer")
	peerCtx := cp.ctxFor(idB, 1)
	idB1 := cp.dispatch(peerCtx, "coder-b")
	coderCtx := cp.ctxFor(idA1, 2)
	for _, id := range []string{idA, idA1, idB, idB1} {
		cp.waitSteerable(cp.root, id)
	}

	t.Run("root and parent list the same nested entry", func(t *testing.T) {
		fromRoot, ok := findDispatch(t, cp.root, idA1)
		if !ok {
			t.Fatalf("root list is missing %s", idA1)
		}
		fromLead, ok := findDispatch(t, leadCtx, idA1)
		if !ok {
			t.Fatalf("lead list is missing %s", idA1)
		}
		if fromRoot.ParentDispatchID != idA || fromRoot.Depth != 2 || fromRoot.Status != "running" {
			t.Errorf("root view of %s = %+v, want parent %s depth 2 running", idA1, fromRoot, idA)
		}
		if fromLead.ParentDispatchID != fromRoot.ParentDispatchID || fromLead.Depth != fromRoot.Depth || fromLead.Status != fromRoot.Status {
			t.Errorf("lead view %+v disagrees with root view %+v", fromLead, fromRoot)
		}
		if _, leaked := findDispatch(t, leadCtx, idB1); leaked {
			t.Errorf("lead list leaked the other branch's %s", idB1)
		}
	})

	t.Run("listed IDs steer at every depth", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			ctx  *extension.Context
			id   string
		}{{"root->A", cp.root, idA}, {"root->A1", cp.root, idA1}, {"lead->A1", leadCtx, idA1}} {
			if res := steer(t, tc.ctx, tc.id); res.Outcome != "delivered" && res.Outcome != "channel_full" {
				t.Errorf("%s steer = %+v, want delivered or channel_full", tc.name, res)
			}
		}
	})

	t.Run("names resolve in the caller's scope", func(t *testing.T) {
		if res, err := cp.root.SteerDispatchByName("lead", "m"); err != nil || (res.Outcome != "delivered" && res.Outcome != "channel_full") {
			t.Errorf("root unique name steer = (%+v, %v)", res, err)
		}
		if res, err := leadCtx.SteerDispatchByName("peer", "m"); err != nil || res.Outcome != "not_found" {
			t.Errorf("lead steer of a name outside its scope = (%+v, %v), want not_found", res, err)
		}
		// Same name in two branches: the root sees both, a branch sees one.
		idB2 := cp.dispatchAs(peerCtx, "coder-a-in-b", "coder-a")
		res, err := cp.root.SteerDispatchByName("coder-a", "m")
		want := []string{idA1, idB2}
		slices.Sort(want)
		if err != nil || res.Outcome != "ambiguous" || !slices.Equal(res.MatchingDispatchIDs, want) {
			t.Errorf("root ambiguous steer = (%+v, %v), want ambiguous over %v", res, err, want)
		}
		cp.waitSteerable(leadCtx, idA1)
		if res, err := leadCtx.SteerDispatchByName("coder-a", "m"); err != nil || (res.Outcome != "delivered" && res.Outcome != "channel_full") {
			t.Errorf("lead steer of its own coder-a = (%+v, %v), want delivered", res, err)
		}
	})

	t.Run("control outside the caller's tree is unauthorized", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			ctx  *extension.Context
			id   string
		}{{"sibling", leadCtx, idB1}, {"self", leadCtx, idA}, {"ancestor", coderCtx, idA}} {
			if res := steer(t, tc.ctx, tc.id); res.Outcome != "unauthorized" {
				t.Errorf("%s steer = %+v, want unauthorized", tc.name, res)
			}
		}
		if res, err := leadCtx.RecallDispatch(idB1, extension.RecallDispatchOpts{Reason: "not mine"}); err != nil || res.Outcome != "unauthorized" {
			t.Errorf("sibling recall = (%+v, %v), want unauthorized", res, err)
		}
		if _, live := findDispatch(t, cp.root, idB1); !live {
			t.Error("an unauthorized recall removed the sibling")
		}

		other := newControlPlane(t, mp, mgr, "cp-other", "")
		t.Cleanup(func() { mgr.StopSession("cp-other") })
		if res := steer(t, other.root, idB1); res.Outcome != "unauthorized" {
			t.Errorf("unrelated session steer = %+v, want unauthorized", res)
		}
		if res, err := other.root.RecallDispatch(idB1, extension.RecallDispatchOpts{Reason: "not mine"}); err != nil || res.Outcome != "unauthorized" {
			t.Errorf("unrelated session recall = (%+v, %v), want unauthorized", res, err)
		}
	})

	t.Run("recall then a racing steer reports completion", func(t *testing.T) {
		res, err := leadCtx.RecallDispatch(idA1, extension.RecallDispatchOpts{Reason: "superseded"})
		if err != nil || res.Outcome != "recalled" || !res.Found {
			t.Fatalf("lead recall of A1 = (%+v, %v), want recalled", res, err)
		}
		cp.waitEnded("coder-a")

		late := steer(t, leadCtx, idA1)
		if late.Outcome != "completed" || late.Terminal == nil {
			t.Fatalf("steer after recall = %+v, want completed with terminal", late)
		}
		if late.Terminal.DispatchID != idA1 || late.Terminal.Status != "cancelled" || late.Terminal.Reason != "superseded" ||
			late.Terminal.ParentDispatchID != idA || late.Terminal.Depth != 2 {
			t.Errorf("terminal = %+v", late.Terminal)
		}
		if again, err := cp.root.RecallDispatch(idA1, extension.RecallDispatchOpts{Reason: "again"}); err != nil || again.Outcome != "completed" {
			t.Errorf("root recall after completion = (%+v, %v), want completed", again, err)
		}
	})
}

// TestDispatchControlPlane_TerminalHistoryAcrossRestart covers the terminal
// half: a nested child's success, error, and recall stay visible to the root
// and to their finished parent, keep their canonical IDs and lineage, and
// survive a session restart and an engine death.
func TestDispatchControlPlane_TerminalHistoryAcrossRestart(t *testing.T) {
	mp := newControlPlaneProvider(t)
	conversationID := conversation.NewConversationID()
	if err := conversation.Save(conversation.CreateConversation(conversationID, "", "mock-model"), ""); err != nil {
		t.Fatalf("save conversation: %v", err)
	}
	mgr := session.NewManager(backend.NewApiBackend())
	cp := newControlPlane(t, mp, mgr, "cp-hist", conversationID)

	// Call 0: the lead holds its run open for the whole scenario.
	mp.SetResponse(helpers.TextResponse("lead working"))
	mp.SetBlockUntilCancel(true)
	idA := cp.dispatch(cp.root, "lead")
	leadCtx := cp.ctxFor(idA, 1)

	// Call 1: a child that finishes cleanly.
	mp.SetBlockUntilCancel(false)
	mp.SetResponse(helpers.TextResponse("ok"))
	idOK := cp.dispatch(leadCtx, "child-ok")
	cp.waitEnded("child-ok")

	// Call 2: a child whose provider fails.
	mp.SetResponseWithError(nil, &providers.ProviderError{Code: "auth", Message: "invalid api key", Retryable: false})
	idErr := cp.dispatch(leadCtx, "child-err")
	cp.waitEnded("child-err")

	// Call 3: a child that is recalled while running.
	mp.SetResponse(helpers.TextResponse("stuck"))
	mp.SetBlockUntilCancel(true)
	idRecall := cp.dispatch(leadCtx, "child-recall")
	if res, err := leadCtx.RecallDispatch(idRecall, extension.RecallDispatchOpts{Reason: "timeout guard"}); err != nil || res.Outcome != "recalled" {
		t.Fatalf("recall child = (%+v, %v)", res, err)
	}
	cp.waitEnded("child-recall")

	// End the lead too, so the root must see nested children whose parent
	// has finished.
	if res, err := cp.root.RecallDispatch(idA, extension.RecallDispatchOpts{Reason: "wrap up"}); err != nil || res.Outcome != "recalled" {
		t.Fatalf("recall lead = (%+v, %v)", res, err)
	}
	cp.waitEnded("lead")

	check := func(t *testing.T, label string, ctx *extension.Context, wantLead bool) {
		t.Helper()
		h := historyByID(t, ctx)
		for _, want := range []struct {
			id, status, reason string
		}{{idOK, "done", ""}, {idErr, "error", ""}, {idRecall, "cancelled", "timeout guard"}} {
			got, ok := h[want.id]
			if !ok {
				t.Errorf("%s: history is missing %s", label, want.id)
				continue
			}
			if got.Status != want.status || got.ParentDispatchID != idA || got.Depth != 2 {
				t.Errorf("%s: %s = %+v, want %s under %s at depth 2", label, want.id, got, want.status, idA)
			}
			if want.reason != "" && got.Reason != want.reason {
				t.Errorf("%s: %s reason = %q, want %q", label, want.id, got.Reason, want.reason)
			}
			if got.ExitCode == nil {
				t.Errorf("%s: %s lost its exit code", label, want.id)
			}
		}
		if h[idErr].Reason == "" {
			t.Errorf("%s: the error child has no reason", label)
		}
		if lead, ok := h[idA]; ok != wantLead || (ok && lead.Status != "cancelled") {
			t.Errorf("%s: lead in history = %v (%+v), want %v", label, ok, lead, wantLead)
		}
	}

	check(t, "root", cp.root, true)
	check(t, "finished parent", leadCtx, false)

	// Session restart: a new session on the same conversation rebuilds the
	// same history with the same identities.
	mgr.StopSession("cp-hist")
	restarted := newControlPlane(t, mp, mgr, "cp-hist-2", conversationID)
	t.Cleanup(func() { mgr.StopSession("cp-hist-2") })
	check(t, "after session restart", restarted.root, true)
	if res := steer(t, restarted.root, idOK); res.Outcome != "completed" || res.Terminal == nil || res.Terminal.Status != "done" {
		t.Errorf("steer of a finished dispatch after restart = %+v, want completed", res)
	}

	// Engine death: a second engine opens the conversation while a dispatch
	// of the first is still running. That dispatch comes back lost.
	mp.SetBlockUntilCancel(true)
	idDoomed := restarted.dispatch(restarted.root, "doomed")
	secondEngine := session.NewManager(backend.NewApiBackend())
	survivor := newControlPlane(t, mp, secondEngine, "cp-hist-3", conversationID)
	t.Cleanup(func() { secondEngine.StopSession("cp-hist-3") })
	doomed, ok := historyByID(t, survivor.root)[idDoomed]
	if !ok || doomed.Status != "lost" || doomed.Reason == "" || doomed.ExitCode != nil {
		t.Errorf("dispatch running at engine death = (%+v, %v), want lost with a reason and no exit code", doomed, ok)
	}
	check(t, "after engine death", survivor.root, true)
}
