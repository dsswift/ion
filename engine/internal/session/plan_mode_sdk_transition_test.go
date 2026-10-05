package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
)

// ctx.enterPlanMode used to flip session state without firing any hook. It
// now takes the shared transition: the hook fires with source "extension" and
// its veto holds.
func TestSessionAccessor_SetPlanModeFiresHookAndHonorsVeto(t *testing.T) {
	mgr, host, ec := transitionSession(t, "sdk-pm")
	var sources []string
	deny := false
	host.SDK().On(extension.HookBeforePlanModeEnter, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		sources = append(sources, payload.(extension.PlanModeEnterInfo).Source)
		if deny {
			no := false
			return &extension.BeforePlanModeEnterResult{Allow: &no, Reason: "not yet"}, nil
		}
		return nil, nil
	})
	mgr.mu.RLock()
	acc := &sessionAccessor{m: mgr, s: mgr.sessions["sdk-pm"], key: "sdk-pm"}
	mgr.mu.RUnlock()

	deny = true
	out := acc.SetPlanMode(true, "safety_gate")
	if out.Allowed || out.Reason != "not yet" {
		t.Fatalf("veto must reach the extension: %+v", out)
	}
	if on, _ := mgr.GetPlanModeState("sdk-pm"); on {
		t.Fatal("vetoed request changed the session")
	}
	if n := len(ec.byType("engine_plan_mode_change_rejected")); n != 1 {
		t.Fatalf("want one rejection event, got %d", n)
	}

	deny = false
	out = acc.SetPlanMode(true, "safety_gate")
	if !out.Allowed || !out.Changed {
		t.Fatalf("allowed request must change the session: %+v", out)
	}
	if len(sources) != 2 || sources[0] != backend.PlanModeSourceExtension {
		t.Fatalf("hook sources = %v, want extension each time", sources)
	}

	// Entering again is a no-op that still reports success.
	out = acc.SetPlanMode(true, "safety_gate")
	if !out.Allowed || out.Changed || len(sources) != 2 {
		t.Fatalf("repeat enter must be a quiet no-op: %+v sources=%v", out, sources)
	}
}

// switchRecordingBackend is a mock backend that can switch a live run.
type switchRecordingBackend struct {
	*mockBackend
	calls []string
}

func (b *switchRecordingBackend) SetRunPlanMode(requestID string, enabled bool, _ string, source string) bool {
	b.calls = append(b.calls, requestID+"|"+source)
	return true
}

// An extension call made while a run is in flight reaches that run.
func TestSessionAccessor_SetPlanModeReachesLiveRun(t *testing.T) {
	be := &switchRecordingBackend{mockBackend: newMockBackend()}
	mgr := NewManager(be)
	if _, err := mgr.StartSession("sdk-live", defaultConfig()); err != nil {
		t.Fatal(err)
	}
	ec := newEventCollector(mgr)
	mgr.mu.Lock()
	s := mgr.sessions["sdk-live"]
	s.requestID = "run-1"
	mgr.mu.Unlock()

	out := (&sessionAccessor{m: mgr, s: s, key: "sdk-live"}).SetPlanMode(true, "gate")
	if !out.Changed {
		t.Fatalf("want a change: %+v", out)
	}
	if len(be.calls) != 1 || be.calls[0] != "run-1|"+backend.PlanModeSourceExtension {
		t.Fatalf("live run not switched: %v", be.calls)
	}
	if n := len(ec.byType("engine_plan_mode_changed")); n != 0 {
		t.Fatalf("the run emits the change event itself; the session must not double it (got %d)", n)
	}
	_, path := mgr.GetPlanModeState("sdk-live")
	if path == "" {
		t.Fatal("entering during a live run must allocate a plan file")
	}
}
