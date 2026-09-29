package backend

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// A delegated CLI runs its own model loop and tools, and before this the
// engine sent no llm.call, tool.execute, tool.failure, provider.ttft or
// context.pressure for any run routed to one, so every tool and model chart
// went dark for CLI-backed work.

func trackedRun(t *testing.T, kind string) (*delegatedTelemetry, *mockTelemetry) {
	t.Helper()
	registerHybridTestModels(t)
	telem := &mockTelemetry{}
	var d delegatedTelemetry
	d.SetRunTelemetry("run-1", telem)
	d.begin("run-1", kind, types.RunOptions{Model: "claude-test-sonnet", SessionKey: "tab-1", ConversationID: "conv-1"})
	return &d, telem
}

func toolCall(id, name string) types.NormalizedEvent {
	return types.NormalizedEvent{Data: &types.ToolCallEvent{ToolID: id, ToolName: name}}
}

func toolResult(id string, isError bool) types.NormalizedEvent {
	return types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: id, Content: "out", IsError: isError}}
}

func TestDelegatedToolSpansAndFailures(t *testing.T) {
	d, telem := trackedRun(t, "claude-code")
	d.observe("run-1", toolCall("t1", "Read"))
	d.observe("run-1", toolCall("t2", "Bash"))
	d.observe("run-1", toolResult("t1", false))
	d.observe("run-1", toolResult("t2", true))

	spans := telem.eventsByName("tool.execute")
	if len(spans) != 2 {
		t.Fatalf("tool.execute = %d, want 2", len(spans))
	}
	if spans[0].Payload["tool"] != "Read" || spans[0].Payload["error"] != nil || spans[0].Payload["backend"] != "claude-code" {
		t.Fatalf("successful span = %v", spans[0].Payload)
	}
	if spans[1].Payload["tool"] != "Bash" || spans[1].Payload["error"] == nil {
		t.Fatalf("failed span must carry an error: %v", spans[1].Payload)
	}
	if spans[0].Ctx["session_id"] != "tab-1" || spans[0].Ctx["conversation_id"] != "conv-1" || spans[0].Ctx["run_id"] != "run-1" {
		t.Fatalf("span must be correlated to the run: %v", spans[0].Ctx)
	}
	failures := telem.eventsByName("tool.failure")
	if len(failures) != 1 || failures[0].Payload["tool"] != "Bash" || failures[0].Payload["failure_category"] != "tool_error" {
		t.Fatalf("tool.failure = %v", failures)
	}
	if _, ok := failures[0].Payload["error_preview"]; ok {
		t.Fatal("minimal privacy must not carry the error text")
	}
}

func streamLine(t *testing.T, parent string, event map[string]any) json.RawMessage {
	t.Helper()
	line := map[string]any{"type": "stream_event", "event": event}
	if parent != "" {
		line["parent_tool_use_id"] = parent
	}
	raw, err := json.Marshal(line)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// Claude streams message_start / message_delta / message_stop per model call,
// and a sub-agent's calls (parent_tool_use_id set) interleave with the main
// agent's. Each call must become its own llm.call.
func TestDelegatedClaudeModelCalls(t *testing.T) {
	d, telem := trackedRun(t, "claude-code")
	r := d.get("run-1")
	start := func(parent string) {
		r.claudeStreamLine(streamLine(t, parent, map[string]any{"type": "message_start", "message": map[string]any{
			"model": "claude-test-sonnet", "usage": map[string]any{"input_tokens": 10, "cache_read_input_tokens": 49990},
		}}))
	}
	stop := func(parent, reason string, out int) {
		r.claudeStreamLine(streamLine(t, parent, map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": reason}, "usage": map[string]any{"output_tokens": out}}))
		r.claudeStreamLine(streamLine(t, parent, map[string]any{"type": "message_stop"}))
	}
	start("")
	start("toolu_sub")
	stop("toolu_sub", "end_turn", 7)
	stop("", "tool_use", 42)
	r.claudeStreamLine(json.RawMessage(`{"type":"assistant","message":{}}`)) // not a stream event

	calls := telem.eventsByName("llm.call")
	if len(calls) != 2 {
		t.Fatalf("llm.call = %d, want 2", len(calls))
	}
	sub, main := calls[0].Payload, calls[1].Payload
	if sub["parent_tool_use_id"] != "toolu_sub" || sub["stop_reason"] != "end_turn" || sub["output_tokens"] != 7 {
		t.Fatalf("sub-agent call = %v", sub)
	}
	if main["stop_reason"] != "tool_use" || main["output_tokens"] != 42 || main["model"] != "claude-test-sonnet" || main["error"] != nil {
		t.Fatalf("main call = %v", main)
	}
	if sub["span_kind"] != telemetry.SpanKindClient || main["span_kind"] != telemetry.SpanKindClient {
		t.Fatalf("llm.call span_kind = %v/%v, want client (an outbound dependency)", sub["span_kind"], main["span_kind"])
	}
	if n := len(telem.eventsByName("provider.ttft")); n != 2 {
		t.Fatalf("provider.ttft = %d, want one per call", n)
	}
	pressure := telem.eventsByName("context.pressure")
	if len(pressure) != 2 || pressure[0].Payload["tokens_used"] != 50000 || pressure[0].Payload["percent"] != 25.0 {
		t.Fatalf("context.pressure = %v", pressure)
	}
}

// A run that ends with a tool or model call still open closes both spans as
// failed rather than leaving them unreported.
func TestDelegatedRunEndClosesOpenSpans(t *testing.T) {
	d, telem := trackedRun(t, "claude-code")
	d.observe("run-1", toolCall("t1", "Bash"))
	d.get("run-1").claudeStreamLine(streamLine(t, "", map[string]any{"type": "message_start", "message": map[string]any{"model": "claude-test-sonnet"}}))
	d.end("run-1")
	for _, name := range []string{"tool.execute", "llm.call"} {
		got := telem.eventsByName(name)
		if len(got) != 1 || got[0].Payload["error"] == nil {
			t.Fatalf("%s at run end = %v, want one failed span", name, got)
		}
	}
	if d.get("run-1") != nil {
		t.Fatal("an ended run must not stay tracked")
	}
	d.observe("run-1", toolCall("t2", "Read"))
	if len(telem.eventsByName("tool.execute")) != 1 {
		t.Fatal("an ended run must not emit")
	}
}

// Codex reports each call's usage and nothing else: context pressure only.
// Claude's usage events are ignored here (its stream markers carry them).
func TestDelegatedUsageEventPressureForCodexOnly(t *testing.T) {
	in := 1000
	usage := types.NormalizedEvent{Data: &types.UsageEvent{Usage: types.UsageData{InputTokens: &in}}}
	codex, codexTelem := trackedRun(t, "codex")
	codex.observe("run-1", usage)
	if got := codexTelem.eventsByName("context.pressure"); len(got) != 1 || got[0].Payload["backend"] != "codex" {
		t.Fatalf("codex context.pressure = %v", got)
	}
	claude, claudeTelem := trackedRun(t, "claude-code")
	claude.observe("run-1", usage)
	if got := claudeTelem.eventsByName("context.pressure"); len(got) != 0 {
		t.Fatalf("claude usage events must not double-report: %v", got)
	}
}

// A run started with no collector is never tracked.
func TestDelegatedRunWithoutCollectorIsUntracked(t *testing.T) {
	var d delegatedTelemetry
	d.begin("run-1", "codex", types.RunOptions{})
	if d.get("run-1") != nil {
		t.Fatal("no collector was set, so nothing is tracked")
	}
}

// telemetryRecordingBackend is a CLI stand-in that records the collector the
// router hands it.
type telemetryRecordingBackend struct {
	*ClaudeCodeBackend
	gotTelemetry TelemetryCollector
	started      bool
}

func (b *telemetryRecordingBackend) SetRunTelemetry(_ string, telem TelemetryCollector) {
	b.gotTelemetry = telem
}

func (b *telemetryRecordingBackend) StartRun(string, types.RunOptions) { b.started = true }

// The router used to drop the whole RunConfig for a CLI-routed run ("cfg
// ignored"), collector included.
func TestHybridHandsTelemetryToCLIRun(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackendWithPrefs(map[string]string{"anthropic": "claude-code"})
	inner := &telemetryRecordingBackend{ClaudeCodeBackend: NewClaudeCodeBackend()}
	h.mu.Lock()
	h.inner["claude-code"] = inner
	h.mu.Unlock()
	telem := &mockTelemetry{}

	h.StartRunWithConfig("req-1", types.RunOptions{Model: "claude-test-sonnet"}, &RunConfig{Telemetry: telem})
	if !inner.started || inner.gotTelemetry != telem {
		t.Fatalf("started=%v telemetry=%v, want the run's collector", inner.started, inner.gotTelemetry)
	}
}
