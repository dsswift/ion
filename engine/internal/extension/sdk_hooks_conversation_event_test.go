package extension

import "testing"

// TestSDK_FireBeforeConversationEvent_MergesHandlerResult pins that a
// registered handler's returned map appears verbatim under the merged
// result FireBeforeConversationEvent returns — the shape
// ConversationEmitter.applyExtensionMetadata attaches under
// "extension_metadata".
func TestSDK_FireBeforeConversationEvent_MergesHandlerResult(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBeforeConversationEvent, func(ctx *Context, payload interface{}) (interface{}, error) {
		return map[string]any{"tenant": "acme"}, nil
	})

	got := sdk.FireBeforeConversationEvent(testCtx(), BeforeConversationEventInfo{EventName: "conversation.user_message"})
	if got["tenant"] != "acme" {
		t.Fatalf("got %v, want tenant=acme", got)
	}
}

// TestSDK_FireBeforeConversationEvent_LastWriterWinsPerKey pins the merge
// semantics: two handlers contribute disjoint keys (both survive) and a
// colliding key resolves to the LAST handler's value, matching every other
// before_* hook's last-writer-wins convention.
func TestSDK_FireBeforeConversationEvent_LastWriterWinsPerKey(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBeforeConversationEvent, func(ctx *Context, payload interface{}) (interface{}, error) {
		return map[string]any{"tenant": "first", "region": "us"}, nil
	})
	sdk.On(HookBeforeConversationEvent, func(ctx *Context, payload interface{}) (interface{}, error) {
		return map[string]any{"tenant": "second"}, nil
	})

	got := sdk.FireBeforeConversationEvent(testCtx(), BeforeConversationEventInfo{EventName: "conversation.tool_call"})
	if got["tenant"] != "second" {
		t.Errorf("tenant = %v, want %q (last handler wins on collision)", got["tenant"], "second")
	}
	if got["region"] != "us" {
		t.Errorf("region = %v, want %q (non-colliding key from an earlier handler survives)", got["region"], "us")
	}
}

// TestSDK_FireBeforeConversationEvent_NoHandlersReturnsNil pins the
// abstain contract: with no handler registered, the result is nil so a
// caller can skip attaching "extension_metadata" entirely.
func TestSDK_FireBeforeConversationEvent_NoHandlersReturnsNil(t *testing.T) {
	sdk := NewSDK()
	got := sdk.FireBeforeConversationEvent(testCtx(), BeforeConversationEventInfo{EventName: "conversation.lifecycle"})
	if got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}
