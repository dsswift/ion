package extension

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func notifyPayload(t *testing.T, title string) []byte {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"params": types.NotifyOpts{Kind: "briefing", ResourceID: "b-1", Title: title, Body: "ready"}})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestExtNotify_PersistentFallback_EmptyCtxStack(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	if h.ctxStack.Current() != nil {
		t.Fatal("precondition: ctxStack must be empty")
	}

	var got types.NotifyOpts
	h.SetPersistentNotify(func(opts types.NotifyOpts) error {
		got = opts
		return nil
	})
	h.handleExtRequest("ext/notify", 1, notifyPayload(t, "Scheduled briefing"))
	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("persistent notification failed: %v", resp["error"])
	}
	if got.Title != "Scheduled briefing" || got.Kind != "briefing" || got.ResourceID != "b-1" {
		t.Fatalf("fallback received %+v", got)
	}
}

func TestExtNotify_CtxArmWinsOverFallback(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	ctxCalled := false
	fallbackCalled := false
	h.ctxStack.Push(&Context{Notify: func(types.NotifyOpts) error {
		ctxCalled = true
		return nil
	}})
	h.SetPersistentNotify(func(types.NotifyOpts) error {
		fallbackCalled = true
		return nil
	})

	h.handleExtRequest("ext/notify", 1, notifyPayload(t, "Live notification"))
	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("live context notification failed: %v", resp["error"])
	}
	if !ctxCalled {
		t.Fatal("live context was not used")
	}
	if fallbackCalled {
		t.Fatal("persistent fallback ran despite live context")
	}
}
