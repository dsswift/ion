package session

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// engine_prompt_injected — emission contract.
//
// An ENGINE-SIDE prompt injection (extension ctx.sendPrompt: dispatch
// completion delivery, check-ins, orchestrator revives) starts a run whose
// user turn no client submitted. Without a typed event, live clients watch
// the model respond to a turn they cannot see — the injected prompt exists
// only in the conversation file until a reload (the reported symptom: the
// ATV, which rehydrates from disk, showed "[Agent X completed in Ns]" turns
// the overlay never displayed).
//
// Pins:
//   - BOTH extension entry seams emit exactly one engine_prompt_injected
//     carrying the verbatim text + the hosting extension's name:
//     sessionAccessor.SendPrompt (active-hook path, also the steerSelf
//     fallback) and dispatchSendPromptPayload (onSendMessage fallback).
//   - The event fires only on ACCEPTED prompts (unknown session → no event).
//
// Client wire prompts (server/dispatch.go → Manager.SendPrompt directly)
// bypass both seams by construction — each client does its own optimistic
// insert, and an echo would duplicate it.

type recordedEvent struct {
	key  string
	typ  string
	text string
	orig string
	kind string
}

type eventRecorder struct {
	mu     sync.Mutex
	events []recordedEvent
	raw    []types.EngineEvent
}

func (r *eventRecorder) attach(m *Manager) {
	m.OnEvent(func(key string, ev types.EngineEvent) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.events = append(r.events, recordedEvent{key, ev.Type, ev.InjectedPrompt, ev.InjectedPromptOrigin, ev.InjectedPromptKind})
		r.raw = append(r.raw, ev)
	})
}

func (r *eventRecorder) injected() []recordedEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.events[:0:0]
	for _, e := range r.events {
		if e.typ == "engine_prompt_injected" {
			out = append(out, e)
		}
	}
	return out
}

func TestDispatchSendPromptPayload_EmitsPromptInjected(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	rec := &eventRecorder{}
	rec.attach(mgr)
	_, _ = mgr.StartSession("inj-fallback", defaultConfig())

	mgr.dispatchSendPromptPayload("inj-fallback", "test", extension.SendPromptPayload{
		Text: "[Agent Dev Lead completed in 26s]\nresult body",
	})

	got := rec.injected()
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 engine_prompt_injected, got %d", len(got))
	}
	if got[0].text != "[Agent Dev Lead completed in 26s]\nresult body" {
		t.Errorf("expected verbatim prompt text, got %q", got[0].text)
	}
	if got[0].key != "inj-fallback" {
		t.Errorf("expected session key on the event, got %q", got[0].key)
	}
}

func TestSessionAccessorSendPrompt_EmitsPromptInjected(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	rec := &eventRecorder{}
	rec.attach(mgr)
	_, _ = mgr.StartSession("inj-accessor", defaultConfig())

	mgr.mu.RLock()
	s := mgr.sessions["inj-accessor"]
	mgr.mu.RUnlock()
	sa := &sessionAccessor{m: mgr, s: s, key: "inj-accessor"}

	if err := sa.SendPrompt("injected via hook path", "", nil); err != nil {
		t.Fatalf("SendPrompt failed: %v", err)
	}

	got := rec.injected()
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 engine_prompt_injected, got %d", len(got))
	}
	if got[0].text != "injected via hook path" {
		t.Errorf("expected verbatim prompt text, got %q", got[0].text)
	}
}

func TestPromptInjected_NotEmittedWhenPromptRejected(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	rec := &eventRecorder{}
	rec.attach(mgr)
	// No session started: SendPrompt fails, so no injection event may fire —
	// the event must never claim a turn that was not accepted.
	mgr.dispatchSendPromptPayload("no-such-session", "test", extension.SendPromptPayload{Text: "dropped"})

	if got := rec.injected(); len(got) != 0 {
		t.Fatalf("expected no engine_prompt_injected for a rejected prompt, got %d", len(got))
	}
}

// setPendingSlashInvocation simulates dispatchCommand stashing the raw slash
// invocation for an extension command whose handler is about to call
// ctx.sendPrompt with the expanded template body.
func setPendingSlashInvocation(t *testing.T, mgr *Manager, key, command string) {
	t.Helper()
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	s, ok := mgr.sessions[key]
	if !ok {
		t.Fatalf("session %q not found", key)
	}
	s.pendingSlashInvocation = &conversation.SlashInvocation{Command: command, Source: "extension"}
}

// A slash-fulfilling injection — an extension command handler calling
// ctx.sendPrompt with the expanded body while a pendingSlashInvocation is
// stashed — must be classified "slash_command" so clients suppress the
// redundant expansion body (the display turn is the command pill). This is the
// exact wall-of-text regression: /align's expanded template rendered as a second
// user message because the injection carried no classification.
func TestPromptInjected_ClassifiesSlashFulfillment(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	rec := &eventRecorder{}
	rec.attach(mgr)
	_, _ = mgr.StartSession("inj-slash", defaultConfig())
	setPendingSlashInvocation(t, mgr, "inj-slash", "/align")

	mgr.dispatchSendPromptPayload("inj-slash", "test", extension.SendPromptPayload{
		Text: "You are running the /align command. (expanded body)",
	})

	got := rec.injected()
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 engine_prompt_injected, got %d", len(got))
	}
	if got[0].kind != SlashCommandInjectionKind {
		t.Errorf("expected kind=%q for a slash-fulfilling injection, got %q", SlashCommandInjectionKind, got[0].kind)
	}
}

// The accessor seam (active-hook / steerSelf path) must classify identically.
func TestSessionAccessorSendPrompt_ClassifiesSlashFulfillment(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	rec := &eventRecorder{}
	rec.attach(mgr)
	_, _ = mgr.StartSession("inj-slash-acc", defaultConfig())
	setPendingSlashInvocation(t, mgr, "inj-slash-acc", "/implement")

	mgr.mu.RLock()
	s := mgr.sessions["inj-slash-acc"]
	mgr.mu.RUnlock()
	sa := &sessionAccessor{m: mgr, s: s, key: "inj-slash-acc"}

	if err := sa.SendPrompt("expanded /implement body", "", nil); err != nil {
		t.Fatalf("SendPrompt failed: %v", err)
	}

	got := rec.injected()
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 engine_prompt_injected, got %d", len(got))
	}
	if got[0].kind != SlashCommandInjectionKind {
		t.Errorf("expected kind=%q, got %q", SlashCommandInjectionKind, got[0].kind)
	}
}

// A plain extension injection (no pending slash invocation) — a check-in,
// revive, or dispatch-completion delivery — carries no classification, so
// clients render it as a genuine user turn.
func TestPromptInjected_PlainInjectionHasEmptyKind(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	rec := &eventRecorder{}
	rec.attach(mgr)
	_, _ = mgr.StartSession("inj-plain", defaultConfig())

	mgr.dispatchSendPromptPayload("inj-plain", "test", extension.SendPromptPayload{Text: "please continue"})

	got := rec.injected()
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 engine_prompt_injected, got %d", len(got))
	}
	if got[0].kind != "" {
		t.Errorf("expected empty kind for a plain injection, got %q", got[0].kind)
	}
}

// An extension-supplied kind always wins over slash-fulfillment inference: a
// dispatch callback that happens to fire while a pendingSlashInvocation is
// stashed keeps its "agent_completion" classification.
func TestPromptInjected_ExtensionKindPreservedOverSlashFulfillment(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	rec := &eventRecorder{}
	rec.attach(mgr)
	_, _ = mgr.StartSession("inj-kind-wins", defaultConfig())
	setPendingSlashInvocation(t, mgr, "inj-kind-wins", "/align")

	mgr.dispatchSendPromptPayload("inj-kind-wins", "test", extension.SendPromptPayload{
		Text: "child result", Kind: "agent_completion",
	})

	got := rec.injected()
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 engine_prompt_injected, got %d", len(got))
	}
	if got[0].kind != "agent_completion" {
		t.Errorf("expected extension kind %q to be preserved, got %q", "agent_completion", got[0].kind)
	}
}

// TestSendPromptDegradedSteer_EmitsDistinctOrderedEvents pins the actual
// accessor path ctx.steerSelf uses after it finds no live owning run.
//
// The prompt event remains classified with the caller's kind. The second event
// is deliberately engine_steer_degraded, NOT engine_steer_injected: no run-loop
// checkpoint drained this delivery, so claiming the established live-drain
// event would change its published semantics for external consumers.
//
// Revert-red: substitute SteerInjectedEvent in SendPromptDegradedSteer and the
// event-type assertion fails; remove the kind threading and the prompt payload
// assertion fails.
func TestSendPromptDegradedSteer_EmitsDistinctOrderedEvents(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	rec := &eventRecorder{}
	rec.attach(mgr)
	_, _ = mgr.StartSession("inj-degraded-steer", defaultConfig())

	mgr.mu.RLock()
	s := mgr.sessions["inj-degraded-steer"]
	mgr.mu.RUnlock()
	sa := &sessionAccessor{m: mgr, s: s, key: "inj-degraded-steer"}
	prompt := "[SYSTEM] Dispatch check-in\n\nYou have been idle."

	if err := sa.SendPromptDegradedSteer(prompt, "", nil, string(types.InjectionKindCheckIn)); err != nil {
		t.Fatalf("SendPromptDegradedSteer failed: %v", err)
	}

	rec.mu.Lock()
	all := append([]types.EngineEvent(nil), rec.raw...)
	rec.mu.Unlock()
	got := make([]types.EngineEvent, 0, 2)
	for _, event := range all {
		if event.Type == "engine_prompt_injected" || event.Type == "engine_steer_degraded" || event.Type == "engine_steer_injected" {
			got = append(got, event)
		}
	}
	if len(got) != 2 {
		t.Fatalf("expected prompt injection then degraded-steer event, got %d relevant events: %#v", len(got), got)
	}
	if got[0].Type != "engine_prompt_injected" {
		t.Fatalf("first event type = %q, want engine_prompt_injected", got[0].Type)
	}
	if got[0].InjectedPromptKind != string(types.InjectionKindCheckIn) {
		t.Errorf("prompt kind = %q, want %q", got[0].InjectedPromptKind, types.InjectionKindCheckIn)
	}
	if !got[0].InjectedPromptMachineAuthored {
		t.Error("checkin prompt must carry machine-authored=true")
	}
	if got[1].Type != "engine_steer_degraded" {
		t.Fatalf("second event type = %q, want engine_steer_degraded", got[1].Type)
	}
	if got[1].SteerDegradedMessageLength != len(prompt) {
		t.Errorf("degraded message length = %d, want %d", got[1].SteerDegradedMessageLength, len(prompt))
	}
	for _, event := range got {
		if event.Type == "engine_steer_injected" {
			t.Fatal("degraded fallback must not emit engine_steer_injected; that event means a live run-loop drain")
		}
	}
}
