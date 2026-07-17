package extension

import (
	"testing"
)

// TestBuildHookEnvelope_DispatchIdentity pins the `_ctx` wire shape for the
// dispatch-identity fields. Root sessions (Depth 0, empty DispatchId) must
// omit both keys — SDK runtimes default depth to 0 / dispatchId to "" when
// absent, so the omission IS the root-session contract. Child sessions
// (Depth > 0) must carry both, giving hooks whose payload has no agent
// identity (session_start, session_end, turn_*) an explicit root-vs-child
// discriminator. This is the session-level counterpart of
// AgentInfo.IsRoot (#227).
func TestBuildHookEnvelope_DispatchIdentity(t *testing.T) {
	h := NewHost()

	// Root session: no depth, no dispatchId on the wire.
	root := h.buildHookEnvelope(&Context{
		Cwd:        "/tmp",
		SessionKey: "sess-root",
	}, nil)
	rootCtx := root["_ctx"].(map[string]interface{})
	if _, present := rootCtx["depth"]; present {
		t.Errorf("root envelope must omit depth, got %v", rootCtx["depth"])
	}
	if _, present := rootCtx["dispatchId"]; present {
		t.Errorf("root envelope must omit dispatchId, got %v", rootCtx["dispatchId"])
	}

	// Child session: both keys present with the context's values.
	child := h.buildHookEnvelope(&Context{
		Cwd:        "/tmp",
		SessionKey: "sess-child",
		Depth:      2,
		DispatchId: "dispatch-abc",
	}, nil)
	childCtx := child["_ctx"].(map[string]interface{})
	if got := childCtx["depth"]; got != 2 {
		t.Errorf("child envelope depth = %v, want 2", got)
	}
	if got := childCtx["dispatchId"]; got != "dispatch-abc" {
		t.Errorf("child envelope dispatchId = %v, want dispatch-abc", got)
	}
}

// TestBuildHookEnvelope_BaseFieldsAndPayloadMerge pins the pre-existing
// envelope behavior through the extracted seam: base `_ctx` keys appear when
// set, and a map payload merges into the top level alongside `_ctx`.
func TestBuildHookEnvelope_BaseFieldsAndPayloadMerge(t *testing.T) {
	h := NewHost()

	env := h.buildHookEnvelope(&Context{
		Cwd:            "/work",
		SessionKey:     "sess-1",
		ConversationID: "conv-1",
	}, map[string]interface{}{"name": "researcher"})

	ctxMap := env["_ctx"].(map[string]interface{})
	if got := ctxMap["cwd"]; got != "/work" {
		t.Errorf("cwd = %v, want /work", got)
	}
	if got := ctxMap["sessionKey"]; got != "sess-1" {
		t.Errorf("sessionKey = %v, want sess-1", got)
	}
	if got := ctxMap["conversationId"]; got != "conv-1" {
		t.Errorf("conversationId = %v, want conv-1", got)
	}
	if got := env["name"]; got != "researcher" {
		t.Errorf("merged payload name = %v, want researcher", got)
	}

	// Non-map payload falls back to the _payload wrapper.
	wrapped := h.buildHookEnvelope(&Context{Cwd: "/work"}, "bare-string")
	if got := wrapped["_payload"]; got != "bare-string" {
		t.Errorf("_payload = %v, want bare-string", got)
	}
}
