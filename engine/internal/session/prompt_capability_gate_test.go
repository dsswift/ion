package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// planlessMockBackend reports a native-session descriptor with PlanMode=false
// (grok's shape) while recording StartRun calls, so the gate's "no dispatch"
// guarantee is directly observable without spawning a real CLI subprocess.
type planlessMockBackend struct{ *mockBackend }

func (m *planlessMockBackend) Capabilities() backend.BackendCapabilities {
	return backend.BackendCapabilities{
		Kind:             "grok",
		ContextModel:     backend.ContextModelNativeSession,
		PlanMode:         false,
		Steering:         false,
		Resume:           true,
		ResumeHandleKind: backend.ResumeHandleAcpSessionID,
	}
}

// TestCapabilityGate_DeclinesPlanModeCleanly pins the dispatch-time gate: a
// plan-mode prompt routed to a backend whose descriptor reports
// PlanMode=false is declined BEFORE dispatch — one typed
// engine_capability_unsupported event, no StartRun, no engine_error, no
// engine_dead — and the session is immediately usable for the next prompt.
func TestCapabilityGate_DeclinesPlanModeCleanly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := &planlessMockBackend{newMockBackend()}
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)
	_, _ = mgr.StartSession("gate-plan", defaultConfig())

	mgr.mu.Lock()
	mgr.sessions["gate-plan"].planMode = true
	mgr.mu.Unlock()

	if err := mgr.SendPrompt("gate-plan", "plan something", nil); err != nil {
		t.Fatalf("gate must decline cleanly (nil error), got %v", err)
	}

	// The typed event fired with the full payload.
	evs := ec.byType("engine_capability_unsupported")
	if len(evs) != 1 {
		t.Fatalf("expected exactly 1 engine_capability_unsupported, got %d", len(evs))
	}
	ev := evs[0].event
	if ev.Capability != "plan_mode" || ev.CapabilityBackend != "grok" || ev.CapabilityReason == "" {
		t.Errorf("event payload = {capability:%q backend:%q reason:%q}, want plan_mode/grok/non-empty", ev.Capability, ev.CapabilityBackend, ev.CapabilityReason)
	}

	// No run was dispatched and no crash-shaped surface fired.
	if keys := mb.startedKeys(); len(keys) != 0 {
		t.Errorf("gate must not dispatch, but StartRun saw %v", keys)
	}
	if n := len(ec.byType("engine_error")); n != 0 {
		t.Errorf("clean decline must not fire engine_error, got %d", n)
	}
	if n := len(ec.byType("engine_dead")); n != 0 {
		t.Errorf("clean decline must not fire engine_dead, got %d", n)
	}

	// The session is idle and immediately usable: the busy guard was
	// released and a non-plan follow-up dispatches normally.
	mgr.mu.Lock()
	s := mgr.sessions["gate-plan"]
	if s.requestID != "" {
		t.Errorf("requestID = %q, want empty after decline", s.requestID)
	}
	s.planMode = false
	mgr.mu.Unlock()

	if err := mgr.SendPrompt("gate-plan", "regular prompt", nil); err != nil {
		t.Fatalf("follow-up prompt after decline: %v", err)
	}
	if keys := mb.startedKeys(); len(keys) != 1 {
		t.Errorf("follow-up prompt must dispatch, StartRun saw %v", keys)
	}
}

// TestCapabilityGate_AllowsPlanModeOnCapableBackend pins the pass-through
// side: a plan-capable descriptor lets the plan-mode prompt dispatch with no
// capability event.
func TestCapabilityGate_AllowsPlanModeOnCapableBackend(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend() // engine-owned descriptor, PlanMode=true
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)
	_, _ = mgr.StartSession("gate-ok", defaultConfig())

	mgr.mu.Lock()
	mgr.sessions["gate-ok"].planMode = true
	mgr.mu.Unlock()

	if err := mgr.SendPrompt("gate-ok", "plan something", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	if keys := mb.startedKeys(); len(keys) != 1 {
		t.Fatalf("plan-capable backend must dispatch, StartRun saw %v", keys)
	}
	if n := len(ec.byType("engine_capability_unsupported")); n != 0 {
		t.Errorf("no capability event expected on a capable backend, got %d", n)
	}
}

// TestTranslate_CapabilityUnsupportedEvent pins the NormalizedEvent →
// EngineEvent mapping for the new variant, so a backend-emitted
// capability_unsupported reaches the wire with the flat field names the TS
// and Swift mirrors declare.
func TestTranslate_CapabilityUnsupportedEvent(t *testing.T) {
	ev := translateToEngineEvent(types.NormalizedEvent{Data: &types.CapabilityUnsupportedEvent{
		Capability: "plan_mode",
		Backend:    "grok",
		Reason:     "plan mode is not supported on the grok backend",
	}}, 0)
	if ev.Type != "engine_capability_unsupported" {
		t.Fatalf("Type = %q, want engine_capability_unsupported", ev.Type)
	}
	if ev.Capability != "plan_mode" || ev.CapabilityBackend != "grok" || ev.CapabilityReason == "" {
		t.Errorf("flat fields = {%q %q %q}, want plan_mode/grok/non-empty", ev.Capability, ev.CapabilityBackend, ev.CapabilityReason)
	}
}
