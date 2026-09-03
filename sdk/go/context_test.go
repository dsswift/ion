package ion

import (
	"encoding/json"
	"testing"
)

// TestNewContextDecodesModelEnvelope pins the actual object shape the engine
// emits for model. A type mismatch here makes encoding/json return an error,
// which would otherwise discard every sibling identity field with the model.
func TestNewContextDecodesModelEnvelope(t *testing.T) {
	sdk := New()
	sdk.cfg = ExtensionConfig{WorkingDirectory: "/from-init"}
	meta := json.RawMessage(`{
		"sessionKey":"session-1",
		"conversationId":"conversation-1",
		"runId":"run-1",
		"traceId":"4bf92f3577b34da6a3ce929d0e0e4736",
		"depth":2,
		"dispatchId":"dispatch-1",
		"cwd":"/work",
		"model":{"id":"opus","contextWindow":200000},
		"identity":{"kind":"operator","provider":"oidc","claims":{"roles":["admin"],"metadata":{"active":true},"empty":null}},
		"config":{"extensionDir":"/extension","model":"opus","workingDirectory":"/work","mcpConfigPath":"/work/mcp.json"}
	}`)

	ctx := sdk.newContext(meta)
	if ctx.SessionKey != "session-1" || ctx.ConversationID != "conversation-1" {
		t.Errorf("session identity = %q / %q, want session-1 / conversation-1", ctx.SessionKey, ctx.ConversationID)
	}
	if ctx.RunID != "run-1" || ctx.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("run identity = %q / %q, want run-1 / trace ID", ctx.RunID, ctx.TraceID)
	}
	if ctx.Depth != 2 || ctx.DispatchID != "dispatch-1" || ctx.Cwd != "/work" {
		t.Errorf("dispatch context = depth %d / ID %q / cwd %q, want 2 / dispatch-1 / /work", ctx.Depth, ctx.DispatchID, ctx.Cwd)
	}
	if ctx.Model == nil {
		t.Fatal("Model = nil, want decoded model reference")
	}
	if ctx.Model.ID != "opus" || ctx.Model.ContextWindow != 200000 {
		t.Errorf("Model = %+v, want opus / 200000", ctx.Model)
	}
	if ctx.Identity == nil || ctx.Identity.Kind != "operator" || ctx.Identity.Provider != "oidc" {
		t.Errorf("Identity = %+v, want decoded identity", ctx.Identity)
	}
	if claims := ctx.Identity.Claims; claims["empty"] != nil || claims["metadata"].(map[string]any)["active"] != true {
		t.Errorf("Identity claims = %#v, want nested JSON values", claims)
	}
	if ctx.Config.ExtensionDir != "/extension" || ctx.Config.McpConfigPath != "/work/mcp.json" {
		t.Errorf("Config = %+v, want decoded envelope config", ctx.Config)
	}
}

// TestNewContextWithoutModelKeepsSiblingFields pins omission as the expected
// no-model shape. A missing optional key must not affect decoded metadata.
func TestNewContextWithoutModelKeepsSiblingFields(t *testing.T) {
	sdk := New()
	sdk.cfg = ExtensionConfig{WorkingDirectory: "/from-init"}
	meta := json.RawMessage(`{
		"sessionKey":"session-2",
		"conversationId":"conversation-2",
		"runId":"run-2",
		"traceId":"trace-2",
		"depth":1,
		"dispatchId":"dispatch-2",
		"cwd":"/child"
	}`)

	ctx := sdk.newContext(meta)
	if ctx.Model != nil {
		t.Errorf("Model = %+v, want nil when engine omitted model", ctx.Model)
	}
	if ctx.Identity != nil {
		t.Errorf("Identity = %+v, want nil when engine omitted identity", ctx.Identity)
	}
	if ctx.SessionKey != "session-2" || ctx.ConversationID != "conversation-2" ||
		ctx.RunID != "run-2" || ctx.TraceID != "trace-2" || ctx.Depth != 1 ||
		ctx.DispatchID != "dispatch-2" || ctx.Cwd != "/child" {
		t.Errorf("context = %+v, want sibling metadata preserved", ctx)
	}
}
