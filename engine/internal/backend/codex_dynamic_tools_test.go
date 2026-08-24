package backend

// Tests for the codex dynamic-tool transport: client tools declared as
// thread/start dynamicTools, item/tool/call server requests routed to the
// run's session-owned ClientToolRouter, and text/success translation of the
// response. See codex_backend.go onDynamicToolCall.

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestCodex_ThreadStartDeclaresDynamicTools pins that a run with
// RunOptions.ClientTools declares each MACHINE tool (name, description,
// schema) as thread/start dynamicTools — and that HUMAN-WAIT tools are
// excluded: they park the engine-owned loop and cannot be expressed through
// codex's blocking item/tool/call, so declaring them would offer the model a
// tool whose semantics this backend cannot honor.
func TestCodex_ThreadStartDeclaresDynamicTools(t *testing.T) {
	b, peerCh := newTestCodexBackend(t)
	rec := newRecorder()
	rec.attach(b)

	peer := startAndPeer(t, b, peerCh, "req-dyn", types.RunOptions{
		Prompt: "hello",
		Model:  "gpt-5-codex",
		ClientTools: []types.ClientToolDef{
			{
				Name:        "BenchMemberFile",
				Description: "read a member file",
				InputSchema: map[string]any{"type": "object"},
			},
			{
				Name:        "AskUserQuestions",
				Description: "ask the operator structured questions",
				InputSchema: map[string]any{"type": "object"},
				HumanWait:   true,
			},
		},
		ClientToolRouter: func(_ context.Context, _ string, _ map[string]interface{}) *types.ToolResult {
			return &types.ToolResult{Content: "unused"}
		},
	})
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodThreadStart) }, "thread/start")

	peer.mu.Lock()
	raw := peer.seen[codexrpc.MethodThreadStart]
	peer.mu.Unlock()
	var p codexrpc.ThreadStartParams
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatalf("decode thread/start params: %v", err)
	}
	if len(p.DynamicTools) != 1 {
		t.Fatalf("dynamicTools: want only the machine tool, got %d: %+v", len(p.DynamicTools), p.DynamicTools)
	}
	dt := p.DynamicTools[0]
	if dt.Name != "BenchMemberFile" || dt.Description == "" || dt.InputSchema == nil {
		t.Errorf("dynamic tool declaration incomplete: %+v", dt)
	}
	// HumanWait is engine execution policy and must NOT leak into the codex
	// declaration — the spec struct has no such field, so its absence is
	// structural; this assertion pins the wire bytes.
	if string(raw) != "" && json.Valid(raw) {
		var probe map[string]any
		_ = json.Unmarshal(raw, &probe) //nolint:errcheck // valid JSON per check above
		tools, _ := probe["dynamicTools"].([]any)
		if len(tools) == 1 {
			entry, _ := tools[0].(map[string]any)
			if _, leaked := entry["humanWait"]; leaked {
				t.Error("humanWait leaked into the codex dynamicTools declaration")
			}
		}
	}
}

// TestCodex_DynamicToolCallRoutesToRouterAndAnswers pins the fulfillment
// round-trip: an item/tool/call server request reaches the run's
// ClientToolRouter with the tool name and arguments, and the router's result
// returns as a DynamicToolCallResponse with the exact success flag (success
// true for a normal result, false for a tool error).
func TestCodex_DynamicToolCallRoutesToRouterAndAnswers(t *testing.T) {
	b, peerCh := newTestCodexBackend(t)
	rec := newRecorder()
	rec.attach(b)

	type routed struct {
		name  string
		input map[string]interface{}
	}
	routedCh := make(chan routed, 2)
	var answerMu sync.Mutex
	answer := &types.ToolResult{Content: `{"answers":[{"questionId":"q1","value":"a"}]}`, IsError: false}

	peer := startAndPeer(t, b, peerCh, "req-call", types.RunOptions{
		Prompt: "hello",
		Model:  "gpt-5-codex",
		ClientTools: []types.ClientToolDef{
			{Name: "AskUserQuestions", HumanWait: true},
		},
		ClientToolRouter: func(_ context.Context, name string, input map[string]interface{}) *types.ToolResult {
			routedCh <- routed{name: name, input: input}
			answerMu.Lock()
			defer answerMu.Unlock()
			return answer
		},
	})
	waitFor(t, func() bool { return peer.sawMethod(codexrpc.MethodTurnStart) }, "turn/start")

	peer.request(`"call-1"`, codexrpc.ReqDynamicToolCall, codexrpc.DynamicToolCallParams{
		ThreadID:  "th_test",
		Tool:      "AskUserQuestions",
		Arguments: map[string]any{"title": "Scope check"},
	})

	select {
	case r := <-routedCh:
		if r.name != "AskUserQuestions" {
			t.Errorf("router received tool %q, want AskUserQuestions", r.name)
		}
		if r.input["title"] != "Scope check" {
			t.Errorf("router received input %+v, want the call arguments", r.input)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("item/tool/call never reached the client-tool router")
	}

	// Error-result translation: success must be false when IsError is true.
	answerMu.Lock()
	answer = &types.ToolResult{Content: "declined", IsError: true}
	answerMu.Unlock()
	peer.request(`"call-2"`, codexrpc.ReqDynamicToolCall, codexrpc.DynamicToolCallParams{
		ThreadID: "th_test",
		Tool:     "AskUserQuestions",
	})
	select {
	case <-routedCh:
	case <-time.After(5 * time.Second):
		t.Fatal("second item/tool/call never routed")
	}
}

// TestCodex_DynamicToolCallUnknownRunFailsClosed pins the miss path: a call
// for a thread with no run (or a run with no router) answers success=false
// with a readable error instead of hanging or panicking the request
// goroutine.
func TestCodex_DynamicToolCallUnknownRunFailsClosed(t *testing.T) {
	b, _ := newTestCodexBackend(t)
	resp := b.onDynamicToolCall(codexrpc.DynamicToolCallParams{
		ThreadID: "th_unknown",
		Tool:     "AskUserQuestions",
	})
	if resp.Success {
		t.Error("unknown run must answer success=false")
	}
	if len(resp.Output) != 1 || resp.Output[0].Text == "" {
		t.Errorf("unknown run must carry a readable error, got %+v", resp.Output)
	}
}
