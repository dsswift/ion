package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// Persistent self-steer is the completion-delivery path used after a dispatched
// child exits. At that point its parent host has no active hook/tool context, so
// ext/steer_self reaches the session callback built by persistentSteerSelf.
//
// These tests call that production helper directly. The prior tests rebuilt a
// lookalike closure and only checked whether a live run was steered; that
// approximation passed while the installed callback discarded opts.kind and
// reclassified machine-authored completions as user turns.

func TestPersistentSteerSelf_LiveRun_PreservesKind(t *testing.T) {
	backendMock := newSteerableMockBackend(backend.SteerResultDelivered)
	manager := NewManager(backendMock)
	if _, err := manager.StartSession("persistent-self-live", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	withActiveRun(t, manager, "persistent-self-live", "run-persistent-self")

	manager.mu.RLock()
	session := manager.sessions["persistent-self-live"]
	manager.mu.RUnlock()
	result, err := manager.persistentSteerSelf(session, "persistent-self-live")(
		"[Agent observability-specialist completed] telemetry",
		string(types.InjectionKindAgentCompletion),
	)
	if err != nil {
		t.Fatalf("persistentSteerSelf: %v", err)
	}
	if !result.Delivered || result.Outcome != "steered" {
		t.Fatalf("result = %+v, want delivered steered", result)
	}

	call, ok := backendMock.lastSteerCall()
	if !ok {
		t.Fatal("persistent fallback did not reach the live run")
	}
	if call.requestID != "run-persistent-self" {
		t.Errorf("steer request ID = %q, want live main run", call.requestID)
	}
	if call.kind != string(types.InjectionKindAgentCompletion) {
		t.Errorf("steer kind = %q, want agent_completion", call.kind)
	}
}

func TestPersistentSteerSelf_IdleRun_PreservesKind(t *testing.T) {
	backendMock := newMockBackend()
	manager := NewManager(backendMock)
	recorder := &eventRecorder{}
	recorder.attach(manager)
	if _, err := manager.StartSession("persistent-self-idle", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	manager.mu.RLock()
	session := manager.sessions["persistent-self-idle"]
	manager.mu.RUnlock()
	result, err := manager.persistentSteerSelf(session, "persistent-self-idle")(
		"[Agent observability-specialist completed] telemetry",
		string(types.InjectionKindAgentCompletion),
	)
	if err != nil {
		t.Fatalf("persistentSteerSelf: %v", err)
	}
	if !result.Delivered || result.Outcome != "sent" {
		t.Fatalf("result = %+v, want delivered sent", result)
	}

	injected := recorder.injected()
	if len(injected) != 1 {
		t.Fatalf("engine_prompt_injected count = %d, want 1", len(injected))
	}
	if injected[0].kind != string(types.InjectionKindAgentCompletion) {
		t.Errorf("injected kind = %q, want agent_completion", injected[0].kind)
	}
	if injected[0].text != "[Agent observability-specialist completed] telemetry" {
		t.Errorf("injected text = %q, want completion text", injected[0].text)
	}

	started := backendMock.startedInOrder()
	if len(started) != 1 {
		t.Fatalf("started runs = %v, want exactly one idle fallback run", started)
	}
	opts, ok := backendMock.getStarted(started[0])
	if !ok {
		t.Fatalf("missing RunOptions for started run %q", started[0])
	}
	if opts.InjectionKind != string(types.InjectionKindAgentCompletion) {
		t.Errorf("RunOptions.InjectionKind = %q, want agent_completion", opts.InjectionKind)
	}
}
