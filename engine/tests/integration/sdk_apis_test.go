//go:build integration

package integration

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// ─── ctx.sessionKey threads through to extensions ───
//
// Extension echoes the session key it observed in `_ctx.sessionKey` back via
// the `before_prompt` return value. Two distinct session keys must produce
// two distinct echoes.
func TestSDK_SessionKey_ThreadsThroughToExtension(t *testing.T) {
	extDir := t.TempDir()
	jsCode := `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const req = JSON.parse(line.trim());
  if (req.method === "init") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [], commands: {} } }) + "\n");
    return;
  }
  if (req.method === "hook/before_prompt") {
    const key = req.params && req.params._ctx && req.params._ctx.sessionKey;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: req.id,
      result: { prompt: "seen:" + (key || "<empty>") }
    }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }) + "\n");
});
`
	entry := filepath.Join(extDir, "index.js")
	if err := os.WriteFile(entry, []byte(jsCode), 0644); err != nil {
		t.Fatalf("write extension: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	cases := []string{"alpha", "beta", "session-with-dashes-123"}
	for _, key := range cases {
		ctx := &extension.Context{SessionKey: key, Cwd: "/tmp"}
		got, _, err := host.FireBeforePrompt(ctx, "ignored")
		if err != nil {
			t.Fatalf("FireBeforePrompt(%q): %v", key, err)
		}
		want := "seen:" + key
		if got != want {
			t.Errorf("session %q: got prompt %q, want %q", key, got, want)
		}
	}

	// Empty SessionKey must not be sent at all -- extension should observe
	// the empty fallback.
	emptyCtx := &extension.Context{Cwd: "/tmp"}
	got, _, err := host.FireBeforePrompt(emptyCtx, "ignored")
	if err != nil {
		t.Fatalf("FireBeforePrompt(empty): %v", err)
	}
	if got != "seen:<empty>" {
		t.Errorf("empty key: got %q, want %q", got, "seen:<empty>")
	}
}

// ─── ctx.callTool round-trip ───
//
// Extension registers a tool `proxy` whose execute issues an `ext/call_tool`
// to dispatch a synthetic tool name `target`. The test's Context wires
// CallTool to a recorder that returns a known string. Asserts the recorder
// observed the call and the tool result reflects what CallTool returned.
func TestSDK_CallTool_RoundTrip(t *testing.T) {
	extDir := t.TempDir()
	jsCode := `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });

let nextId = 1;
const pending = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function callTool(name, input) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method: "ext/call_tool", params: { name, input } });
  });
}

rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line.trim()); } catch { return; }

  // Response to one of our outgoing ext/call_tool requests.
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "rpc error"));
      else p.resolve(msg.result);
    }
    return;
  }

  if (msg.method === "init") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      tools: [{ name: "proxy", description: "Calls target via callTool", parameters: {} }],
      commands: {},
    }});
    return;
  }
  if (msg.method === "tool/proxy") {
    try {
      const r = await callTool("target", { ping: "pong" });
      send({ jsonrpc: "2.0", id: msg.id, result: { content: r.content, isError: !!r.isError } });
    } catch (err) {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: String(err && err.message || err), isError: true } });
    }
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, result: null });
});
`
	entry := filepath.Join(extDir, "index.js")
	if err := os.WriteFile(entry, []byte(jsCode), 0644); err != nil {
		t.Fatalf("write extension: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	type call struct {
		name  string
		input map[string]interface{}
	}
	var (
		mu    sync.Mutex
		calls []call
	)

	ctx := &extension.Context{
		SessionKey: "callTool-roundtrip",
		Cwd:        "/tmp",
		CallTool: func(toolName string, input map[string]interface{}) (string, bool, error) {
			mu.Lock()
			calls = append(calls, call{name: toolName, input: input})
			mu.Unlock()
			if toolName == "target" {
				return fmt.Sprintf("ack:%v", input["ping"]), false, nil
			}
			return "", true, fmt.Errorf("unknown tool: %s", toolName)
		},
	}

	tools := host.Tools()
	if len(tools) != 1 || tools[0].Name != "proxy" {
		t.Fatalf("expected single 'proxy' tool, got %v", toolNames(tools))
	}

	result, err := tools[0].Execute(map[string]interface{}{}, ctx)
	if err != nil {
		t.Fatalf("Execute proxy: %v", err)
	}
	if result == nil {
		t.Fatal("Execute returned nil result")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 1 {
		t.Fatalf("expected 1 callTool, got %d", len(calls))
	}
	if calls[0].name != "target" {
		t.Errorf("callTool name: got %q, want %q", calls[0].name, "target")
	}
	if calls[0].input["ping"] != "pong" {
		t.Errorf("callTool input.ping: got %v, want %q", calls[0].input["ping"], "pong")
	}

	// The tool result is JSON-encoded by the host (it pretty-prints unknown
	// content shapes) -- assert the proxy's reported content survived.
	if result.IsError {
		t.Errorf("expected non-error result, got isError=true content=%q", result.Content)
	}
	if !contains(result.Content, "ack:pong") {
		t.Errorf("expected result content to contain %q, got %q", "ack:pong", result.Content)
	}
}

// ─── ctx.callTool with unknown tool name ───
//
// Extension calls a name not wired to anything in the harness. CallTool
// returns a Go error; host forwards as JSON-RPC error; SDK promise rejects;
// extension's tool reports isError=true.
func TestSDK_CallTool_UnknownToolRejects(t *testing.T) {
	extDir := t.TempDir()
	jsCode := `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });

let nextId = 1;
const pending = new Map();
function send(o){ process.stdout.write(JSON.stringify(o)+"\n"); }
function callTool(name,input){ const id=nextId++; return new Promise((res,rej)=>{ pending.set(id,{res,rej}); send({jsonrpc:"2.0",id,method:"ext/call_tool",params:{name,input}}); }); }

rl.on("line", async (line) => {
  let msg; try { msg = JSON.parse(line.trim()); } catch { return; }
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message||"rpc")); else p.res(msg.result); }
    return;
  }
  if (msg.method === "init") {
    send({ jsonrpc:"2.0", id: msg.id, result: { tools: [{ name: "probe", description: "", parameters: {} }], commands: {} }});
    return;
  }
  if (msg.method === "tool/probe") {
    try {
      await callTool("does_not_exist", {});
      send({ jsonrpc:"2.0", id: msg.id, result: { content: "promise did not reject", isError: true }});
    } catch (err) {
      send({ jsonrpc:"2.0", id: msg.id, result: { content: "rejected:" + String(err.message||err), isError: false }});
    }
    return;
  }
  send({ jsonrpc:"2.0", id: msg.id, result: null });
});
`
	entry := filepath.Join(extDir, "index.js")
	if err := os.WriteFile(entry, []byte(jsCode), 0644); err != nil {
		t.Fatalf("write extension: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	ctx := &extension.Context{
		SessionKey: "callTool-unknown",
		Cwd:        "/tmp",
		CallTool: func(toolName string, _ map[string]interface{}) (string, bool, error) {
			return "", true, errors.New("unknown tool: " + toolName)
		},
	}

	tools := host.Tools()
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}

	result, err := tools[0].Execute(map[string]interface{}{}, ctx)
	if err != nil {
		t.Fatalf("Execute probe: %v", err)
	}
	if result == nil {
		t.Fatal("nil result")
	}
	if result.IsError {
		t.Errorf("expected probe to recover from rejection (isError=false), got isError=true content=%q", result.Content)
	}
	if !contains(result.Content, "rejected:") || !contains(result.Content, "unknown tool") {
		t.Errorf("expected rejection text in content, got %q", result.Content)
	}
}

// ─── Custom EngineEvent types pass through verbatim ───
//
// Extension emits a custom event type the engine doesn't recognise during
// a tool execution. Asserts the event is delivered to ctx.Emit unchanged
// (the engine already validates only `engine_agent_state`; other types
// pass through). The event-emit happens during a tool call (post-init) so
// it stresses the per-call Context.Emit path that real sessions hit.
func TestSDK_CustomEngineEvent_PassesThrough(t *testing.T) {
	extDir := t.TempDir()
	jsCode := `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const req = JSON.parse(line.trim());
  if (req.method === "init") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {
      tools: [{ name: "emit_custom", description: "fires a custom event", parameters: {} }],
      commands: {}
    }}) + "\n");
    return;
  }
  if (req.method === "tool/emit_custom") {
    // Emit a custom event before responding to the tool call.
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "ext/emit",
      params: { type: "jarvis_inbox_update", count: 3, source: "mail" }
    }) + "\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { content: "ok" }}) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }) + "\n");
});
`
	entry := filepath.Join(extDir, "index.js")
	if err := os.WriteFile(entry, []byte(jsCode), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	var (
		mu     sync.Mutex
		events []types.EngineEvent
	)
	ctx := &extension.Context{
		SessionKey: "custom-event-test",
		Cwd:        "/tmp",
		Emit: func(ev types.EngineEvent) {
			mu.Lock()
			events = append(events, ev)
			mu.Unlock()
		},
	}

	tools := host.Tools()
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	if _, err := tools[0].Execute(map[string]interface{}{}, ctx); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	// Custom events are emitted via notify() so they may drain after the
	// tool call returns -- give the read loop a brief moment.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(events)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	var found *types.EngineEvent
	for i := range events {
		if events[i].Type == "jarvis_inbox_update" {
			found = &events[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("expected custom event 'jarvis_inbox_update', got %d events: %+v", len(events), events)
	}
}

// ─── Custom event during init does not deadlock the host ───
//
// Regression test for a deadlock: Load holds h.mu for the entire init
// handshake, while the readLoop's notification dispatch acquires the same
// lock to read persistentEmit / onSendMessage. An extension that emits
// (or sendMessage's) before responding to init would deadlock both.
//
// Fix: notification-dispatch fields live under a separate notifMu (RWMutex)
// so the readLoop never contends with Load.
func TestSDK_NotificationDuringInit_DoesNotDeadlock(t *testing.T) {
	extDir := t.TempDir()
	jsCode := `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const req = JSON.parse(line.trim());
  if (req.method === "init") {
    // Emit a custom event AND send a message BEFORE responding to init.
    // Both notifications hit the readLoop while Load still holds h.mu.
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", method: "ext/emit",
      params: { type: "init_emit", phase: "before_response" }
    }) + "\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", method: "ext/send_message",
      params: { text: "hello during init" }
    }) + "\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [], commands: {} }}) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }) + "\n");
});
`
	entry := filepath.Join(extDir, "index.js")
	if err := os.WriteFile(entry, []byte(jsCode), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	var (
		emitMu     sync.Mutex
		emitEvents []types.EngineEvent
	)
	host.SetPersistentEmit(func(ev types.EngineEvent) {
		emitMu.Lock()
		emitEvents = append(emitEvents, ev)
		emitMu.Unlock()
	})

	var (
		msgMu    sync.Mutex
		messages []string
	)
	host.SetOnSendMessage(func(text string) {
		msgMu.Lock()
		messages = append(messages, text)
		msgMu.Unlock()
	})

	// Use a goroutine + timeout so a regression deadlocks the test rather
	// than the test runner's 10-minute default.
	done := make(chan error, 1)
	go func() {
		done <- host.Load(entry, &extension.ExtensionConfig{
			ExtensionDir:     extDir,
			WorkingDirectory: "/tmp",
		})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Load returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Load deadlocked (>5s)")
	}

	// Notifications fire from the readLoop; allow a brief drain.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		emitMu.Lock()
		gotEmit := len(emitEvents)
		emitMu.Unlock()
		msgMu.Lock()
		gotMsg := len(messages)
		msgMu.Unlock()
		if gotEmit > 0 && gotMsg > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	emitMu.Lock()
	defer emitMu.Unlock()
	if len(emitEvents) == 0 || emitEvents[0].Type != "init_emit" {
		t.Errorf("expected persistentEmit to receive 'init_emit', got %+v", emitEvents)
	}
	msgMu.Lock()
	defer msgMu.Unlock()
	if len(messages) == 0 || messages[0] != "hello during init" {
		t.Errorf("expected onSendMessage to receive 'hello during init', got %v", messages)
	}
}

// ─── extension.json manifest: unknown keys reject ───
func TestExtensionManifest_UnknownKeysReject(t *testing.T) {
	extDir := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(extDir, "extension.json"),
		[]byte(`{"unknownField": 42}`),
		0644,
	); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(extDir, "index.js"),
		[]byte(`process.stdout.write("");`),
		0644,
	); err != nil {
		t.Fatalf("write index: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	err := host.Load(filepath.Join(extDir, "index.js"), &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	})
	if err == nil {
		t.Fatal("expected manifest load to fail on unknown field, got nil")
	}
	if !contains(err.Error(), "unknown field") {
		t.Errorf("expected error to mention unknown field, got %q", err.Error())
	}
}

// ─── extension.json manifest: external deps flow through esbuild ───
//
// Declares an external in extension.json, references it from the TypeScript
// entry, and asserts the bundle is produced (esbuild does not error on
// unresolved imports for declared externals). Also asserts NODE_PATH is
// honored when node_modules exists -- the extension's index uses a stub
// module installed under node_modules.
func TestExtensionManifest_ExternalDepsResolve(t *testing.T) {
	requireEsbuild(t)
	extDir := t.TempDir()

	// Manifest declares an external dep.
	if err := os.WriteFile(
		filepath.Join(extDir, "extension.json"),
		[]byte(`{"name": "ext-with-external", "external": ["fake-native"]}`),
		0644,
	); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	// Stub "native" dep installed under node_modules. We don't run npm
	// install here -- this test is about external resolution, not install
	// orchestration. Just plant the module directly.
	depDir := filepath.Join(extDir, "node_modules", "fake-native")
	if err := os.MkdirAll(depDir, 0755); err != nil {
		t.Fatalf("mkdir dep: %v", err)
	}
	if err := os.WriteFile(filepath.Join(depDir, "package.json"),
		[]byte(`{"name":"fake-native","version":"1.0.0","main":"index.js"}`),
		0644,
	); err != nil {
		t.Fatalf("write dep package.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(depDir, "index.js"),
		[]byte(`module.exports = { tag: "from-fake-native" };`),
		0644,
	); err != nil {
		t.Fatalf("write dep index.js: %v", err)
	}

	tsCode := `import native from "fake-native"
import { createInterface } from "node:readline"
const rl = createInterface({ input: process.stdin, terminal: false })
rl.on("line", (line: string) => {
  const req = JSON.parse(line.trim())
  if (req.method === "init") {
    process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id: req.id, result: {
      tools: [{ name: "tag_" + native.tag.replace(/-/g, "_"), description: "", parameters: {} }],
      commands: {}
    }}) + "\n")
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id: req.id, result: null }) + "\n")
})
`
	entry := filepath.Join(extDir, "index.ts")
	if err := os.WriteFile(entry, []byte(tsCode), 0644); err != nil {
		t.Fatalf("write index.ts: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	tools := host.Tools()
	if len(tools) != 1 || tools[0].Name != "tag_from_fake_native" {
		t.Errorf("expected tool name to incorporate fake-native runtime value, got %v", toolNames(tools))
	}
}

// ─── Top-level await transpiles and runs ───
//
// Verifies the ESM/node20 esbuild config supports top-level `await` in
// extension code. The extension runs an async init at module scope to
// populate a tools list, then registers it during init handshake.
func TestSDK_TopLevelAwait_TranspilesAndRuns(t *testing.T) {
	requireEsbuild(t)
	extDir := t.TempDir()
	tsCode := `import { setTimeout as sleep } from "node:timers/promises"

async function loadToolNames(): Promise<string[]> {
  await sleep(1)
  return ["tla_works"]
}

const names = await loadToolNames()

import { createInterface } from "node:readline"
const rl = createInterface({ input: process.stdin, terminal: false })
rl.on("line", (line: string) => {
  const req = JSON.parse(line.trim())
  if (req.method === "init") {
    const tools = names.map(n => ({ name: n, description: "tla", parameters: {} }))
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools, commands: {} }}) + "\n")
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }) + "\n")
})
`
	entry := filepath.Join(extDir, "index.ts")
	if err := os.WriteFile(entry, []byte(tsCode), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	tools := host.Tools()
	if len(tools) != 1 || tools[0].Name != "tla_works" {
		t.Errorf("expected single 'tla_works' tool, got %v", toolNames(tools))
	}
}

// ─── ctx.sendPrompt round-trip ───
//
// Slash command issues `ext/send_prompt` with optional model override. The
// host's SendPrompt callback records the call. Asserts text and model echo.
func TestSDK_SendPrompt_RoundTrip(t *testing.T) {
	extDir := t.TempDir()
	jsCode := `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });

let nextId = 1;
const pending = new Map();
function send(o){ process.stdout.write(JSON.stringify(o)+"\n"); }
function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    send({ jsonrpc:"2.0", id, method, params });
  });
}

rl.on("line", async (line) => {
  let msg; try { msg = JSON.parse(line.trim()); } catch { return; }
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message||"rpc")); else p.res(msg.result); }
    return;
  }
  if (msg.method === "init") {
    send({ jsonrpc:"2.0", id: msg.id, result: {
      tools: [],
      commands: { "kickoff": { description: "fire two prompts" } }
    }});
    return;
  }
  if (msg.method === "command/kickoff") {
    try {
      await rpc("ext/send_prompt", { text: "first", model: "claude-haiku-4-5-20251001" });
      await rpc("ext/send_prompt", { text: "second", model: "" });
      send({ jsonrpc:"2.0", id: msg.id, result: null });
    } catch (err) {
      send({ jsonrpc:"2.0", id: msg.id, error: { code: -32000, message: String(err.message||err) }});
    }
    return;
  }
  send({ jsonrpc:"2.0", id: msg.id, result: null });
});
`
	entry := filepath.Join(extDir, "index.js")
	if err := os.WriteFile(entry, []byte(jsCode), 0644); err != nil {
		t.Fatalf("write extension: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	type sendCall struct {
		text  string
		model string
	}
	var (
		mu    sync.Mutex
		calls []sendCall
	)

	ctx := &extension.Context{
		SessionKey: "sendPrompt-test",
		Cwd:        "/tmp",
		SendPrompt: func(text string, model string) error {
			mu.Lock()
			calls = append(calls, sendCall{text: text, model: model})
			mu.Unlock()
			return nil
		},
	}

	cmds := host.Commands()
	cmd, ok := cmds["kickoff"]
	if !ok {
		t.Fatalf("expected kickoff command, got %v", cmdNames(cmds))
	}
	if err := cmd.Execute("", ctx); err != nil {
		t.Fatalf("Execute kickoff: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 2 {
		t.Fatalf("expected 2 sendPrompt calls, got %d (%v)", len(calls), calls)
	}
	if calls[0].text != "first" || calls[0].model != "claude-haiku-4-5-20251001" {
		t.Errorf("first call: got %+v", calls[0])
	}
	if calls[1].text != "second" || calls[1].model != "" {
		t.Errorf("second call: got %+v", calls[1])
	}
}

// ─── ctx.sendPrompt surfaces engine errors ───
//
// SendPrompt callback returns an error -> host responds with JSON-RPC error
// -> SDK promise rejects -> command's catch branch fires.
func TestSDK_SendPrompt_ErrorPropagates(t *testing.T) {
	extDir := t.TempDir()
	jsCode := `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });

let nextId = 1;
const pending = new Map();
function send(o){ process.stdout.write(JSON.stringify(o)+"\n"); }
function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    send({ jsonrpc:"2.0", id, method, params });
  });
}

rl.on("line", async (line) => {
  let msg; try { msg = JSON.parse(line.trim()); } catch { return; }
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message||"rpc")); else p.res(msg.result); }
    return;
  }
  if (msg.method === "init") {
    send({ jsonrpc:"2.0", id: msg.id, result: { tools: [], commands: { "fail": { description: "" } }}});
    return;
  }
  if (msg.method === "command/fail") {
    try {
      await rpc("ext/send_prompt", { text: "anything", model: "" });
      send({ jsonrpc:"2.0", id: msg.id, error: { code: -32000, message: "promise did not reject" }});
    } catch (err) {
      send({ jsonrpc:"2.0", id: msg.id, error: { code: -32000, message: String(err.message||err) }});
    }
    return;
  }
  send({ jsonrpc:"2.0", id: msg.id, result: null });
});
`
	entry := filepath.Join(extDir, "index.js")
	if err := os.WriteFile(entry, []byte(jsCode), 0644); err != nil {
		t.Fatalf("write extension: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	ctx := &extension.Context{
		SessionKey: "sendPrompt-err",
		Cwd:        "/tmp",
		SendPrompt: func(text string, model string) error {
			return fmt.Errorf("simulated queue full")
		},
	}

	cmd := host.Commands()["fail"]
	if cmd.Execute == nil {
		t.Fatal("missing fail command")
	}
	err := cmd.Execute("", ctx)
	if err == nil {
		t.Fatal("expected command Execute to return an error")
	}
	if !contains(err.Error(), "simulated queue full") {
		t.Errorf("expected error to mention 'simulated queue full', got %q", err.Error())
	}
}

// contains is a tiny helper to keep the assertions readable; the JSON-pretty
// formatter the host applies to opaque content makes substring assertions
// the most stable check.
func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	if len(needle) == 0 {
		return 0
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

