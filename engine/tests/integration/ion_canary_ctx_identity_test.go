//go:build integration

package integration

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
)

// ctxIdentityResult mirrors the JSON the canary_ctx_identity tool returns.
type ctxIdentityResult struct {
	Depth      int    `json:"depth"`
	DispatchId string `json:"dispatchId"`
	SessionKey string `json:"sessionKey"`
}

func execCtxIdentity(t *testing.T, host *extension.Host, ctx *extension.Context) ctxIdentityResult {
	t.Helper()
	tool := findTool(t, host, "canary_ctx_identity")
	result, err := tool.Execute(map[string]any{}, ctx)
	if err != nil {
		t.Fatalf("execute canary_ctx_identity: %v", err)
	}
	// The subprocess responds with the tool's {content: string} envelope;
	// unwrap it, then parse the JSON string the canary tool built.
	var envelope struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(result.Content), &envelope); err != nil {
		t.Fatalf("parse canary_ctx_identity envelope %q: %v", result.Content, err)
	}
	var parsed ctxIdentityResult
	if err := json.Unmarshal([]byte(envelope.Content), &parsed); err != nil {
		t.Fatalf("parse canary_ctx_identity content %q: %v", envelope.Content, err)
	}
	return parsed
}

// TestCanary_CtxDispatchIdentityRoundTrip pins the full Go → JSON-RPC → TS
// runtime round-trip of the dispatch-identity context fields. Root contexts
// (Depth 0) omit both keys on the wire, and the SDK's buildContext defaults
// must materialize the root shape (depth 0, empty dispatchId). Child
// contexts (Depth > 0) must surface both values verbatim on ctx. This is
// what a session_start handler branches on to skip root-only bootstrap in
// dispatched child sessions.
func TestCanary_CtxDispatchIdentityRoundTrip(t *testing.T) {
	host := loadCanary(t)

	root := execCtxIdentity(t, host, &extension.Context{Cwd: "/tmp", SessionKey: "sess-root"})
	if root.Depth != 0 {
		t.Errorf("root ctx.depth = %d, want 0", root.Depth)
	}
	if root.DispatchId != "" {
		t.Errorf("root ctx.dispatchId = %q, want empty", root.DispatchId)
	}
	if root.SessionKey != "sess-root" {
		t.Errorf("root ctx.sessionKey = %q, want sess-root", root.SessionKey)
	}

	child := execCtxIdentity(t, host, &extension.Context{
		Cwd:        "/tmp",
		SessionKey: "sess-child",
		Depth:      2,
		DispatchId: "dispatch-abc",
	})
	if child.Depth != 2 {
		t.Errorf("child ctx.depth = %d, want 2", child.Depth)
	}
	if child.DispatchId != "dispatch-abc" {
		t.Errorf("child ctx.dispatchId = %q, want dispatch-abc", child.DispatchId)
	}
}
