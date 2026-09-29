package ion

import (
	"context"
	"testing"
)

// TestSessionsListDecodesRealWireShape pins SessionListEntry's JSON tags
// against the engine's ACTUAL ext/list_sessions response shape (see
// engine/internal/extension/sdk_types.go's SessionListEntry). Before this
// fix, SessionKey's tag was "sessionKey" (the wire sends "key") and Status
// asked for a field the wire has never sent at all (the wire sends
// HasActiveRun as a bool) -- both always decoded to their zero value.
func TestSessionsListDecodesRealWireShape(t *testing.T) {
	fe := newFakeEngine(t, WithName("list-sessions-wire-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	resultCh := make(chan []SessionListEntry, 1)
	errCh := make(chan error, 1)
	go func() {
		entries, err := fe.sdk.newContext(nil).Sessions().List(context.Background())
		resultCh <- entries
		errCh <- err
	}()

	frame := fe.awaitMethod("ext/list_sessions")
	id, ok := frame["id"].(float64)
	if !ok {
		t.Fatalf("request id = %#v", frame["id"])
	}
	// Exactly the shape engine/internal/extension/sdk_types.go's
	// SessionListEntry marshals -- the real wire response, not a shape
	// convenient for the Go struct.
	fe.respond(id, []map[string]any{
		{
			"key":              "session-abc",
			"hasActiveRun":     true,
			"extensionName":    "my-ext",
			"conversationId":   "conv-1",
			"principalSubject": "oidc:alice",
		},
	})

	if err := <-errCh; err != nil {
		t.Fatalf("Sessions().List: %v", err)
	}
	entries := <-resultCh
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d: %+v", len(entries), entries)
	}
	got := entries[0]
	want := SessionListEntry{
		SessionKey:       "session-abc",
		HasActiveRun:     true,
		ExtensionName:    "my-ext",
		ConversationID:   "conv-1",
		PrincipalSubject: "oidc:alice",
	}
	if got != want {
		t.Errorf("decoded entry = %+v, want %+v", got, want)
	}
}
