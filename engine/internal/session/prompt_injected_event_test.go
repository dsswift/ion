package session

import (
	"sync"
	"testing"

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

type eventRecorder struct {
	mu     sync.Mutex
	events []struct {
		key  string
		typ  string
		text string
		orig string
	}
}

func (r *eventRecorder) attach(m *Manager) {
	m.OnEvent(func(key string, ev types.EngineEvent) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.events = append(r.events, struct {
			key  string
			typ  string
			text string
			orig string
		}{key, ev.Type, ev.InjectedPrompt, ev.InjectedPromptOrigin})
	})
}

func (r *eventRecorder) injected() []struct {
	key  string
	typ  string
	text string
	orig string
} {
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
