package extension

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// loadHookLatencyExt spawns a minimal node extension that completes the init
// handshake (reporting the given name) and answers every hook/* RPC with a
// result echoed from the request payload's "__reply" field (so a test can drive
// a {"block":true} response), or {} when absent. It returns a loaded host ready
// for callHook. The version field is set directly (Load reads version from a
// manifest, which this bare-script harness does not provide).
func loadHookLatencyExt(t *testing.T, name, version string) *Host {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}
	dir := t.TempDir()
	jsPath := filepath.Join(dir, "hook-latency-ext.js")
	src := `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === 'init') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: '` + name + `' } }) + '\n');
    return;
  }
  if (typeof msg.method === 'string' && msg.method.startsWith('hook/')) {
    const reply = (msg.params && msg.params.__reply) ? msg.params.__reply : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: reply }) + '\n');
    return;
  }
});
setInterval(() => {}, 1000);
`
	if err := os.WriteFile(jsPath, []byte(src), 0o644); err != nil {
		t.Fatalf("write tmp ext: %v", err)
	}
	h := NewHost()
	done := make(chan error, 1)
	go func() { done <- h.Load(jsPath, &ExtensionConfig{WorkingDirectory: dir}) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Load failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Load timed out")
	}
	t.Cleanup(func() { h.Dispose() })
	h.version = version
	return h
}

// capturedTelem is one telemetry emission recorded by a test sink.
type capturedTelem struct {
	name    string
	payload map[string]any
	ctx     map[string]any
}

// Test 1 — Real attribution. callHook emits exactly one extension.hook_latency
// with the real extension name (not ""), the fired hook kind, a float latency,
// the live turn, and full correlation ctx. On pre-fix code callHook emitted
// nothing here (the aggregate lived in the backend runloop), so this is RED.
func TestCallHook_EmitsRealAttribution(t *testing.T) {
	h := loadHookLatencyExt(t, "my-ext", "1.2.3")

	var got []capturedTelem
	h.SetTelemetrySink(func(event string, payload, ctx map[string]any) {
		got = append(got, capturedTelem{event, payload, ctx})
	})

	ctx := &Context{
		Cwd:            "/tmp",
		SessionKey:     "sk",
		ConversationID: "cv",
		GetTurn:        func() int64 { return 3 },
	}
	if _, err := h.callHook("hook/tool_call", ctx, map[string]interface{}{"toolName": "Bash"}); err != nil {
		t.Fatalf("callHook: %v", err)
	}

	var events []capturedTelem
	for _, e := range got {
		if e.name == "extension.hook_latency" {
			events = append(events, e)
		}
	}
	if len(events) != 1 {
		t.Fatalf("expected exactly 1 extension.hook_latency, got %d", len(events))
	}
	p := events[0].payload
	if p["extension"] != "my-ext" {
		t.Errorf("extension = %v, want my-ext (must NOT be empty)", p["extension"])
	}
	if p["hook"] != "tool_call" {
		t.Errorf("hook = %v, want tool_call", p["hook"])
	}
	lat, ok := p["latency_ms"].(float64)
	if !ok {
		t.Fatalf("latency_ms is %T, want float64", p["latency_ms"])
	}
	if lat <= 0 {
		t.Errorf("latency_ms = %v, want > 0", lat)
	}
	if turn, ok := p["turn"].(int64); !ok || turn != 3 {
		t.Errorf("turn = %v (%T), want int64(3)", p["turn"], p["turn"])
	}
	c := events[0].ctx
	if c["session_id"] != "sk" {
		t.Errorf("ctx.session_id = %v, want sk", c["session_id"])
	}
	if c["conversation_id"] != "cv" {
		t.Errorf("ctx.conversation_id = %v, want cv", c["conversation_id"])
	}
	if c["extension_version"] != "1.2.3" {
		t.Errorf("ctx.extension_version = %v, want 1.2.3", c["extension_version"])
	}
}

// Test 2 — Hook kind is dynamic, derived from method, not a hardcoded literal.
// Driving two different methods must produce two events whose hook fields match
// their own kinds. Pins the "generalizes to every hook family" property.
func TestCallHook_HookKindIsDynamic(t *testing.T) {
	h := loadHookLatencyExt(t, "my-ext", "")

	var got []capturedTelem
	h.SetTelemetrySink(func(event string, payload, ctx map[string]any) {
		if event == "extension.hook_latency" {
			got = append(got, capturedTelem{event, payload, ctx})
		}
	})

	ctx := &Context{Cwd: "/tmp"}
	if _, err := h.callHook("hook/tool_call", ctx, nil); err != nil {
		t.Fatalf("callHook tool_call: %v", err)
	}
	if _, err := h.callHook("hook/turn_start", ctx, nil); err != nil {
		t.Fatalf("callHook turn_start: %v", err)
	}

	if len(got) != 2 {
		t.Fatalf("expected 2 events, got %d", len(got))
	}
	if got[0].payload["hook"] != "tool_call" {
		t.Errorf("event 0 hook = %v, want tool_call", got[0].payload["hook"])
	}
	if got[1].payload["hook"] != "turn_start" {
		t.Errorf("event 1 hook = %v, want turn_start", got[1].payload["hook"])
	}
}

// Test 3 — blocked reflects the RPC result precisely. A {"block":true} response
// yields blocked=true; a plain/empty response yields blocked=false.
func TestCallHook_BlockedFromResult(t *testing.T) {
	h := loadHookLatencyExt(t, "my-ext", "")

	var got []capturedTelem
	h.SetTelemetrySink(func(event string, payload, ctx map[string]any) {
		if event == "extension.hook_latency" {
			got = append(got, capturedTelem{event, payload, ctx})
		}
	})

	ctx := &Context{Cwd: "/tmp"}
	// __reply drives the node harness to answer with {block:true,reason:"x"}.
	if _, err := h.callHook("hook/tool_call", ctx, map[string]interface{}{
		"__reply": map[string]interface{}{"block": true, "reason": "x"},
	}); err != nil {
		t.Fatalf("callHook block: %v", err)
	}
	if _, err := h.callHook("hook/tool_call", ctx, nil); err != nil {
		t.Fatalf("callHook plain: %v", err)
	}

	if len(got) != 2 {
		t.Fatalf("expected 2 events, got %d", len(got))
	}
	if got[0].payload["blocked"] != true {
		t.Errorf("blocked (block response) = %v, want true", got[0].payload["blocked"])
	}
	if got[1].payload["blocked"] != false {
		t.Errorf("blocked (plain response) = %v, want false", got[1].payload["blocked"])
	}
}

// Test 4 — Latency conversion expression. Documents the exact expression used at
// callHook: float64(µs)/1000.0 preserves sub-millisecond values, where the
// pre-fix Milliseconds() would floor to 0. Relocated from the backend package
// to sit beside the emission it describes.
func TestCallHook_LatencyConversionSubMillisecond(t *testing.T) {
	const sub = 500 * time.Microsecond
	fractional := float64(sub.Microseconds()) / 1000.0
	if fractional != 0.5 {
		t.Fatalf("float µs/1000 conversion = %v, want 0.5 for 500µs", fractional)
	}
	if floored := sub.Milliseconds(); floored != 0 {
		t.Fatalf("Milliseconds() = %d, want 0 (demonstrates why the fractional form is required)", floored)
	}
}

// Test 5 — Nil-sink safety. With no telemetry sink set, callHook emits nothing
// and does not panic; the round-trip result is returned unchanged.
func TestCallHook_NilSinkSafe(t *testing.T) {
	h := loadHookLatencyExt(t, "my-ext", "")
	// No SetTelemetrySink call: telemFn stays nil.

	ctx := &Context{Cwd: "/tmp"}
	raw, err := h.callHook("hook/tool_call", ctx, map[string]interface{}{
		"__reply": map[string]interface{}{"ok": true},
	})
	if err != nil {
		t.Fatalf("callHook with nil sink: %v", err)
	}
	var parsed map[string]any
	if json.Unmarshal(raw, &parsed) != nil || parsed["ok"] != true {
		t.Errorf("round-trip result not returned unchanged: %s", string(raw))
	}
}
