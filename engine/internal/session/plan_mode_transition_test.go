package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
)

func transitionSession(t *testing.T, key string) (*Manager, *extension.Host, *eventCollector) {
	t.Helper()
	mgr := NewManager(newMockBackend())
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatal(err)
	}
	host := attachTestHost(t, mgr, key)
	return mgr, host, newEventCollector(mgr)
}

func wireEnter(enabled bool) PlanModeTransitionRequest {
	return PlanModeTransitionRequest{Enabled: enabled, Source: backend.PlanModeSourceWire}
}

func TestTransitionPlanMode_WireFiresHookWithSource(t *testing.T) {
	mgr, host, ec := transitionSession(t, "pm-wire")
	var sources []string
	host.SDK().On(extension.HookBeforePlanModeEnter, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		sources = append(sources, payload.(extension.PlanModeEnterInfo).Source)
		return nil, nil
	})

	res := mgr.TransitionPlanMode("pm-wire", wireEnter(true))
	if !res.Allowed || !res.Changed {
		t.Fatalf("wire enter should succeed: %+v", res)
	}
	if len(sources) != 1 || sources[0] != backend.PlanModeSourceWire {
		t.Fatalf("hook must fire once with source wire, got %v", sources)
	}
	changed := ec.byType("engine_plan_mode_changed")
	if len(changed) != 1 || !changed[0].event.PlanModeEnabled || changed[0].event.PlanModeSource != backend.PlanModeSourceWire {
		t.Fatalf("want one sourced engine_plan_mode_changed, got %+v", changed)
	}
	mode, _ := mgr.GetPlanModeState("pm-wire")
	if !mode {
		t.Fatal("session must be in plan mode")
	}
}

// The veto binds a user's own toggle; the client is told why.
func TestTransitionPlanMode_VetoBlocksWireToggle(t *testing.T) {
	mgr, host, ec := transitionSession(t, "pm-veto")
	no := false
	host.SDK().On(extension.HookBeforePlanModeEnter, func(_ *extension.Context, _ interface{}) (interface{}, error) {
		return &extension.BeforePlanModeEnterResult{Allow: &no, Reason: "policy: stay in auto"}, nil
	})

	res := mgr.TransitionPlanMode("pm-veto", wireEnter(true))
	if res.Allowed || res.Changed || res.Reason != "policy: stay in auto" {
		t.Fatalf("veto must refuse with the reason: %+v", res)
	}
	if mode, _ := mgr.GetPlanModeState("pm-veto"); mode {
		t.Fatal("a vetoed toggle must not change the session")
	}
	rej := ec.byType("engine_plan_mode_change_rejected")
	if len(rej) != 1 || !rej[0].event.PlanModeRequestedEnabled || rej[0].event.PlanModeRejectReason != "policy: stay in auto" || rej[0].event.PlanModeSource != backend.PlanModeSourceWire {
		t.Fatalf("want one rejected event carrying the request and reason, got %+v", rej)
	}
	if len(ec.byType("engine_plan_mode_changed")) != 0 {
		t.Fatal("a vetoed toggle must not emit plan_mode_changed")
	}
}

func TestTransitionPlanMode_ExitFiresExitHook(t *testing.T) {
	mgr, host, _ := transitionSession(t, "pm-exit")
	mgr.TransitionPlanMode("pm-exit", wireEnter(true))
	var exitSource string
	host.SDK().On(extension.HookBeforePlanModeExit, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		exitSource = payload.(extension.BeforePlanModeExitInfo).Source
		return nil, nil
	})
	if res := mgr.TransitionPlanMode("pm-exit", wireEnter(false)); !res.Changed {
		t.Fatalf("exit should apply: %+v", res)
	}
	if exitSource != backend.PlanModeSourceWire {
		t.Fatalf("exit hook source = %q", exitSource)
	}
}

// Guard B: a request for the current mode fires nothing and emits nothing.
func TestTransitionPlanMode_IdempotentNoHookNoEvent(t *testing.T) {
	mgr, host, ec := transitionSession(t, "pm-idem")
	fired := 0
	host.SDK().On(extension.HookBeforePlanModeExit, func(_ *extension.Context, _ interface{}) (interface{}, error) {
		fired++
		return nil, nil
	})
	res := mgr.TransitionPlanMode("pm-idem", wireEnter(false))
	if !res.Allowed || res.Changed || fired != 0 || ec.count() != 0 {
		t.Fatalf("no-op toggle fired=%d events=%d res=%+v", fired, ec.count(), res)
	}
}

// Guard A: a handler that requests the same transition from inside the hook
// gets it, and the hook does not fire a second time.
func TestTransitionPlanMode_ReentrantRequestDoesNotRefire(t *testing.T) {
	mgr, host, ec := transitionSession(t, "pm-reenter")
	fired := 0
	host.SDK().On(extension.HookBeforePlanModeEnter, func(_ *extension.Context, _ interface{}) (interface{}, error) {
		fired++
		inner := mgr.TransitionPlanMode("pm-reenter", PlanModeTransitionRequest{Enabled: true, Source: backend.PlanModeSourceExtension})
		if !inner.Changed {
			t.Errorf("the re-entrant request should apply the change: %+v", inner)
		}
		return nil, nil
	})

	outer := mgr.TransitionPlanMode("pm-reenter", wireEnter(true))
	if fired != 1 {
		t.Fatalf("hook fired %d times, want 1", fired)
	}
	if !outer.Allowed || outer.Changed {
		t.Fatalf("outer request finds the change already made: %+v", outer)
	}
	if n := len(ec.byType("engine_plan_mode_changed")); n != 1 {
		t.Fatalf("want exactly one plan_mode_changed, got %d", n)
	}
	mgr.mu.RLock()
	stuck := mgr.sessions["pm-reenter"].planModeHookDispatching
	mgr.mu.RUnlock()
	if stuck {
		t.Fatal("the dispatching flag must clear after the hook returns")
	}
}
