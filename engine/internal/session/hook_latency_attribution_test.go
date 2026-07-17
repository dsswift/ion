package session

// End-to-end plumbing pin for per-extension hook_latency attribution.
//
// This is the highest-value test in the plan: it proves BOTH halves of the
// threading are actually connected through the real session lifecycle, not
// merely unit-present:
//   - § 2a: the telemetry sink is injected onto every loaded host during
//     loadAndWireExtensions (host.SetTelemetrySink(s.telemetry.Event)).
//   - § 2b: ctx.GetTurn is wired in wireExtensionHooks as a closure over
//     apiBackend.GetCurrentTurn(requestID), so callHook stamps the live run
//     turn on each emission.
//
// It drives a genuine ApiBackend run: a scripted provider returns a tool_use
// block, the runloop fans the tool_call hook out through the loaded node
// subprocess (callHook), and the emission lands in the session's real
// telemetry.Collector. Assert one extension.hook_latency carrying the real
// extension name and the run's turn.
//
// RED on unfixed code: with the callHook emission absent (Commit 2 reverted),
// no extension.hook_latency reaches the collector from this path and the
// len==1 assertion fails; with the sink un-wired, telemFn stays nil and the
// same assertion fails; with GetTurn un-wired, turn is 0 instead of the run's
// live turn.

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// scriptedProvider is a minimal LlmProvider that replays scripted stream
// sequences, one per Stream call. Local to this file so the session test does
// not depend on the backend package's test-only mock.
type scriptedProvider struct {
	id        string
	mu        sync.Mutex
	responses [][]types.LlmStreamEvent
	calls     int
}

func (p *scriptedProvider) ID() string { return p.id }

func (p *scriptedProvider) CountTokens(_ context.Context, _ providers.CountTokensRequest) (int, error) {
	return 0, providers.ErrCountUnsupported
}

func (p *scriptedProvider) Stream(ctx context.Context, _ types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 32)
	errc := make(chan error, 1)
	p.mu.Lock()
	idx := p.calls
	p.calls++
	var evs []types.LlmStreamEvent
	if idx < len(p.responses) {
		evs = p.responses[idx]
	} else if len(p.responses) > 0 {
		evs = p.responses[len(p.responses)-1]
	}
	p.mu.Unlock()
	go func() {
		defer close(events)
		defer close(errc)
		for _, ev := range evs {
			select {
			case events <- ev:
			case <-ctx.Done():
				errc <- ctx.Err()
				return
			}
		}
	}()
	return events, errc
}

// writeHookLatencyExt writes a minimal manifest-less node extension whose init
// handshake reports a name and which answers every subsequent request (every
// hook/* fire) with a null result so hooks return promptly.
func writeHookLatencyExt(t *testing.T, dir string) string {
	t.Helper()
	src := `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'init') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'latency-ext' } }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }) + '\n');
  }
});
setInterval(() => {}, 1000);
`
	jsPath := filepath.Join(dir, "latency-ext.js")
	if err := os.WriteFile(jsPath, []byte(src), 0o644); err != nil {
		t.Fatalf("write tmp ext: %v", err)
	}
	return jsPath
}

func TestHookLatencyAttribution_EndToEnd_RealLifecycle(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	dir := t.TempDir()
	const provID = "hook-latency-e2e-provider"
	const modelID = "hook-latency-e2e-model"
	mock := &scriptedProvider{
		id: provID,
		responses: [][]types.LlmStreamEvent{
			// Turn 1: the model asks to Read a file, driving executeTools and
			// therefore the OnToolCall hook fan-out to the extension.
			toolUseResponse("Read", "tc-e2e", map[string]interface{}{"path": filepath.Join(dir, "x.txt")}),
			// Turn 2: plain text ends the run.
			textStreamResponse("done"),
		},
	}
	providers.RegisterProvider(mock)
	providers.RegisterModel(modelID, types.ModelInfo{
		ProviderID:      provID,
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})

	jsPath := writeHookLatencyExt(t, dir)
	// The Read target must exist so the tool succeeds cleanly (the hook fires
	// regardless, but a clean tool result keeps the run on the happy path).
	if err := os.WriteFile(filepath.Join(dir, "x.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatalf("seed read target: %v", err)
	}

	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	defer mgr.Shutdown()

	// Enable telemetry via the manager runtime config so StartSession builds a
	// real collector and loadAndWireExtensions injects it as the host sink.
	mgr.SetConfig(&types.EngineRuntimeConfig{
		Telemetry: &types.TelemetryConfig{Enabled: true, Targets: []string{}},
	})

	cfg := defaultConfig()
	cfg.WorkingDirectory = dir
	cfg.Extensions = []string{jsPath}

	done := make(chan error, 1)
	go func() {
		_, err := mgr.StartSession("hl-e2e", cfg)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("StartSession failed: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("StartSession timed out")
	}

	mgr.mu.Lock()
	s := mgr.sessions["hl-e2e"]
	collector := s.telemetry
	mgr.mu.Unlock()
	if collector == nil {
		t.Fatal("expected session to have a telemetry collector wired from config")
	}

	if err := mgr.SendPrompt("hl-e2e", "read the file", &PromptOverrides{Model: modelID}); err != nil {
		t.Fatalf("SendPrompt failed: %v", err)
	}

	// Wait for the tool_call hook_latency emission to arrive in the collector
	// buffer. Other hook families (session_start, turn_start, ...) also emit
	// through the same wired sink; we assert on the tool_call one because it is
	// the only family fired from inside an active run (so turn > 0), proving the
	// GetTurn accessor is connected to the live run.
	toolCallLatency := func() []telemetry.Event {
		var out []telemetry.Event
		for _, e := range collector.BufferedEvents() {
			if e.Name == "extension.hook_latency" && e.Payload["hook"] == "tool_call" {
				out = append(out, e)
			}
		}
		return out
	}
	ok := waitForCount(func() int { return len(toolCallLatency()) }, 1)
	if !ok {
		t.Fatalf("timed out waiting for tool_call extension.hook_latency; buffered: %+v", collector.BufferedEvents())
	}

	hookLatency := toolCallLatency()
	e := hookLatency[0]
	if e.Payload["extension"] != "latency-ext" {
		t.Errorf("extension = %v, want latency-ext (sink/attribution not wired)", e.Payload["extension"])
	}
	if e.Payload["hook"] != "tool_call" {
		t.Errorf("hook = %v, want tool_call", e.Payload["hook"])
	}
	// GetTurn wiring (§ 2b): the run's live turn must be stamped, not 0.
	turn, ok := e.Payload["turn"].(int64)
	if !ok {
		t.Fatalf("turn = %T, want int64", e.Payload["turn"])
	}
	if turn < 1 {
		t.Errorf("turn = %d, want >= 1 (GetTurn accessor not wired to the live run)", turn)
	}
	assertCtxStr(t, e.Context, "extension", "latency-ext")

	// Let the run drain to completion before the test returns, so mgr.Shutdown
	// and t.TempDir cleanup do not race the in-flight backend run goroutine
	// (which is still emitting turn-2 events on its own goroutine).
	waitForCount(func() int {
		mgr.mu.Lock()
		rid := s.requestID
		mgr.mu.Unlock()
		if rid == "" || !apiBackend.IsRunning(rid) {
			return 1
		}
		return 0
	}, 1)
}

// toolUseResponse builds a scripted stream that emits a single tool_use block.
// Local to this test file to avoid coupling to backend-package test helpers.
func toolUseResponse(toolName, toolID string, input map[string]interface{}) []types.LlmStreamEvent {
	stopReason := "tool_use"
	inputJSON := "{"
	first := true
	for k, v := range input {
		if !first {
			inputJSON += ","
		}
		first = false
		if sv, ok := v.(string); ok {
			inputJSON += `"` + k + `":"` + sv + `"`
		}
	}
	inputJSON += "}"
	return []types.LlmStreamEvent{
		{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m-tool", Model: "mock", Usage: types.LlmUsage{InputTokens: 10}}},
		{Type: "content_block_start", BlockIndex: 0, ContentBlock: &types.LlmStreamContentBlock{Type: "tool_use", ID: toolID, Name: toolName}},
		{Type: "content_block_delta", BlockIndex: 0, Delta: &types.LlmStreamDelta{Type: "input_json_delta", PartialJSON: inputJSON}},
		{Type: "content_block_stop", BlockIndex: 0},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason}, DeltaUsage: &types.LlmUsage{OutputTokens: 8}},
		{Type: "message_stop"},
	}
}

// textStreamResponse builds a scripted stream that emits a simple text turn.
func textStreamResponse(text string) []types.LlmStreamEvent {
	stopReason := "end_turn"
	return []types.LlmStreamEvent{
		{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m-text", Model: "mock", Usage: types.LlmUsage{InputTokens: 10}}},
		{Type: "content_block_start", BlockIndex: 0, ContentBlock: &types.LlmStreamContentBlock{Type: "text"}},
		{Type: "content_block_delta", BlockIndex: 0, Delta: &types.LlmStreamDelta{Type: "text_delta", Text: text}},
		{Type: "content_block_stop", BlockIndex: 0},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason}, DeltaUsage: &types.LlmUsage{OutputTokens: 5}},
		{Type: "message_stop"},
	}
}
