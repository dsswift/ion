//go:build integration

package integration

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/server"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// ─── Helpers ───

func requireEsbuild(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("esbuild"); err != nil {
		t.Skip("esbuild not installed, skipping TypeScript extension test")
	}
}

func ionMetaDir(t *testing.T) string {
	t.Helper()
	repoDir := filepath.Join("..", "..", "extensions", "ion-meta")
	if _, err := os.Stat(filepath.Join(repoDir, "index.ts")); err == nil {
		abs, _ := filepath.Abs(repoDir)
		return abs
	}
	home, _ := os.UserHomeDir()
	installed := filepath.Join(home, ".ion", "extensions", "ion-meta")
	if _, err := os.Stat(filepath.Join(installed, "index.ts")); err == nil {
		return installed
	}
	t.Fatal("ion-meta extension not found")
	return ""
}

// findResultLine scans lines for a {"cmd":"result"} response and returns it.
func findResultLine(t *testing.T, lines []string) *protocol.ServerResult {
	t.Helper()
	for _, l := range lines {
		if strings.Contains(l, `"cmd":"result"`) {
			var r protocol.ServerResult
			if err := json.Unmarshal([]byte(l), &r); err != nil {
				t.Fatalf("unmarshal result: %v", err)
			}
			return &r
		}
	}
	return nil
}

// findSessionList scans lines for a {"cmd":"session_list"} response.
func findSessionList(t *testing.T, lines []string) *protocol.ServerSessionList {
	t.Helper()
	for _, l := range lines {
		if strings.Contains(l, `"cmd":"session_list"`) {
			var r protocol.ServerSessionList
			if err := json.Unmarshal([]byte(l), &r); err != nil {
				t.Fatalf("unmarshal session_list: %v", err)
			}
			return &r
		}
	}
	return nil
}

func toolNames(tools []extension.ToolDefinition) []string {
	names := make([]string, len(tools))
	for i, tool := range tools {
		names[i] = tool.Name
	}
	return names
}

func cmdNames(cmds map[string]extension.CommandDefinition) []string {
	names := make([]string, 0, len(cmds))
	for k := range cmds {
		names = append(names, k)
	}
	return names
}

// ─── IonServe: socket lifecycle + prompt round-trip ───

func TestIonServeAndPrompt(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "test.sock")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer srv.Stop()

	conn := dialSocket(t, sockPath)

	// Start session (must include requestId to get a response)
	sendCmd(t, conn, map[string]interface{}{
		"cmd":       "start_session",
		"key":       "serve-test-1",
		"requestId": "req-1",
		"config": map[string]interface{}{
			"profileId":        "test",
			"workingDirectory": "/tmp",
			"model":            "mock-model",
		},
	})

	lines := readLines(t, conn, 5, 2*time.Second)
	r := findResultLine(t, lines)
	if r == nil {
		t.Fatalf("no result response for start_session; lines=%v", lines)
	}
	if !r.OK {
		t.Fatalf("start_session failed: %s", r.Error)
	}

	// Send prompt (no requestId needed -- fire-and-forget style, backend receives)
	sendCmd(t, conn, map[string]interface{}{
		"cmd":       "send_prompt",
		"key":       "serve-test-1",
		"text":      "Hello from serve test",
		"requestId": "req-2",
	})
	time.Sleep(100 * time.Millisecond)

	// Verify backend received prompt
	keys := mb.StartedKeys()
	if len(keys) == 0 {
		t.Fatal("expected at least 1 started run")
	}
	opts, ok := mb.GetStarted(keys[0])
	if !ok {
		t.Fatal("run not found")
	}
	if opts.Prompt != "Hello from serve test" {
		t.Errorf("expected prompt 'Hello from serve test', got %q", opts.Prompt)
	}

	// List sessions
	conn2 := dialSocket(t, sockPath)
	sendCmd(t, conn2, map[string]interface{}{"cmd": "list_sessions"})
	listLines := readLines(t, conn2, 3, 2*time.Second)
	sl := findSessionList(t, listLines)
	if sl == nil {
		t.Fatalf("no session_list response; lines=%v", listLines)
	}
	if len(sl.Sessions) != 1 {
		t.Errorf("expected 1 session, got %d", len(sl.Sessions))
	}
}

// ─── IonPrompt: session manager prompt lifecycle ───

func TestIonPromptLifecycle(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	cfg := types.EngineConfig{
		ProfileID:        "test",
		WorkingDirectory: "/tmp",
		Model:            "mock-model",
	}

	if err := mgr.StartSession("prompt-lc-1", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("prompt-lc-1") })

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}

	// First prompt
	if err := mgr.SendPrompt("prompt-lc-1", "First prompt", nil); err != nil {
		t.Fatalf("SendPrompt 1: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) != 1 {
		t.Fatalf("expected 1 run, got %d", len(keys))
	}
	opts, _ := mb.GetStarted(keys[0])
	if opts.Prompt != "First prompt" {
		t.Errorf("expected 'First prompt', got %q", opts.Prompt)
	}

	// Complete first run, send second prompt
	code := 0
	mb.EmitExit(keys[0], &code, nil, "prompt-lc-1")
	time.Sleep(50 * time.Millisecond)

	if err := mgr.SendPrompt("prompt-lc-1", "Second prompt", nil); err != nil {
		t.Fatalf("SendPrompt 2: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	keys = mb.StartedKeys()
	if len(keys) != 2 {
		t.Fatalf("expected 2 runs, got %d", len(keys))
	}
	opts2, _ := mb.GetStarted(keys[1])
	if opts2.Prompt != "Second prompt" {
		t.Errorf("expected 'Second prompt', got %q", opts2.Prompt)
	}
}

// ─── IonPrompt: abort cancels active run ───

func TestIonPromptAbort(t *testing.T) {
	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	cfg := types.EngineConfig{
		ProfileID:        "test",
		WorkingDirectory: "/tmp",
		Model:            "mock-model",
	}

	if err := mgr.StartSession("abort-lc-1", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("abort-lc-1") })

	if err := mgr.SendPrompt("abort-lc-1", "Long running task", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	if !mgr.IsRunning("abort-lc-1") {
		t.Error("expected session to be running")
	}

	mgr.SendAbort("abort-lc-1")

	keys := mb.StartedKeys()
	if len(keys) == 0 {
		t.Fatal("no runs started")
	}
	if !mb.Cancel(keys[0]) {
		t.Error("expected Cancel to succeed")
	}
}

// ─── TypeScript extension: transpile + load ───

func TestTSExtensionTranspileAndLoad(t *testing.T) {
	requireEsbuild(t)

	extDir := t.TempDir()
	tsCode := `import * as readline from "readline";

function respond(id: number, result: any): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line: string) => {
  const req = JSON.parse(line.trim());
  if (req.method === "init") {
    respond(req.id, {
      tools: [{ name: "test_tool", description: "A test tool", parameters: {} }],
      commands: { "/test": { description: "Test command" } },
    });
  } else {
    respond(req.id, null);
  }
});
`
	os.WriteFile(filepath.Join(extDir, "index.ts"), []byte(tsCode), 0644)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	err := host.Load(extDir, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	})
	if err != nil {
		t.Fatalf("Load TS extension: %v", err)
	}

	tools := host.Tools()
	found := false
	for _, tool := range tools {
		if tool.Name == "test_tool" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected tool 'test_tool', got: %v", toolNames(tools))
	}

	cmds := host.Commands()
	if _, ok := cmds["/test"]; !ok {
		t.Errorf("expected command '/test', got: %v", cmdNames(cmds))
	}
}

// ─── TypeScript extension: hook forwarding ───

func TestTSExtensionHookForwarding(t *testing.T) {
	requireEsbuild(t)

	extDir := t.TempDir()
	tsCode := `import * as readline from "readline";

function respond(id: number, result: any): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line: string) => {
  const req = JSON.parse(line.trim());
  if (req.method === "init") {
    respond(req.id, { tools: [], commands: {} });
  } else {
    respond(req.id, null);
  }
});
`
	os.WriteFile(filepath.Join(extDir, "index.ts"), []byte(tsCode), 0644)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(extDir, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	ctx := &extension.Context{Cwd: "/tmp"}

	// Fire hooks -- should not error (RPC round-trips succeed)
	host.FireSessionStart(ctx)
	host.FireMessageStart(ctx)
	host.FireMessageEnd(ctx)
	host.FireSessionEnd(ctx)
}

// ─── ion-meta: loads and registers tools + commands ───

func TestIonMetaExtensionLoad(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(metaDir, &extension.ExtensionConfig{
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load ion-meta: %v", err)
	}

	// Verify 3 tools
	tools := host.Tools()
	for _, expected := range []string{"ion_scaffold", "ion_validate_agent", "ion_list_hooks"} {
		found := false
		for _, tool := range tools {
			if tool.Name == expected {
				found = true
			}
		}
		if !found {
			t.Errorf("missing tool %q, got: %v", expected, toolNames(tools))
		}
	}

	// Verify /ion-meta command
	cmds := host.Commands()
	if _, ok := cmds["/ion-meta"]; !ok {
		t.Errorf("missing command '/ion-meta', got: %v", cmdNames(cmds))
	}
}

// ─── ion-meta: hooks fire cleanly ───

func TestIonMetaHooksFireClean(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(metaDir, &extension.ExtensionConfig{
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	ctx := &extension.Context{Cwd: "/tmp"}

	if err := host.FireSessionStart(ctx); err != nil {
		t.Errorf("FireSessionStart: %v", err)
	}
	if err := host.FireMessageStart(ctx); err != nil {
		t.Errorf("FireMessageStart: %v", err)
	}
	if err := host.FireMessageEnd(ctx); err != nil {
		t.Errorf("FireMessageEnd: %v", err)
	}

	// before_prompt should pass through unchanged (ion-meta returns {value: ""})
	prompt, system, err := host.FireBeforePrompt(ctx, "test prompt")
	if err != nil {
		t.Errorf("FireBeforePrompt: %v", err)
	}
	if prompt != "test prompt" {
		t.Errorf("expected prompt unchanged, got %q", prompt)
	}
	if system != "" {
		t.Errorf("expected empty system addition, got %q", system)
	}

	if err := host.FireSessionEnd(ctx); err != nil {
		t.Errorf("FireSessionEnd: %v", err)
	}
}

// ─── ion-meta: session manager integration ───

func TestIonMetaSessionIntegration(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)

	mb := helpers.NewMockBackend()
	mgr := session.NewManager(mb)

	cfg := types.EngineConfig{
		ProfileID:        "test",
		ExtensionDir:     metaDir,
		WorkingDirectory: "/tmp",
		Model:            "mock-model",
	}

	if err := mgr.StartSession("meta-test-1", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("meta-test-1") })

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}

	if err := mgr.SendPrompt("meta-test-1", "Help me build an extension", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	time.Sleep(100 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) == 0 {
		t.Fatal("expected at least 1 run started")
	}
	opts, _ := mb.GetStarted(keys[0])
	if opts.Prompt != "Help me build an extension" {
		t.Errorf("expected prompt text, got %q", opts.Prompt)
	}
}

// ─── ion-meta: full serve + socket end-to-end ───

func TestIonServeWithMetaExtension(t *testing.T) {
	requireEsbuild(t)
	metaDir := ionMetaDir(t)

	sockPath := filepath.Join(t.TempDir(), "test.sock")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer srv.Stop()

	conn := dialSocket(t, sockPath)

	// Start session with ion-meta extension
	sendCmd(t, conn, map[string]interface{}{
		"cmd":       "start_session",
		"key":       "serve-meta-1",
		"requestId": "req-1",
		"config": map[string]interface{}{
			"profileId":        "test",
			"extensionDir":     metaDir,
			"workingDirectory": "/tmp",
			"model":            "mock-model",
		},
	})

	lines := readLines(t, conn, 5, 3*time.Second)
	r := findResultLine(t, lines)
	if r == nil {
		t.Fatalf("no result for start_session; lines=%v", lines)
	}
	if !r.OK {
		t.Fatalf("start_session failed: %s", r.Error)
	}

	// Send prompt
	sendCmd(t, conn, map[string]interface{}{
		"cmd":       "send_prompt",
		"key":       "serve-meta-1",
		"text":      "Scaffold a new extension called my-ext",
		"requestId": "req-2",
	})
	time.Sleep(150 * time.Millisecond)

	keys := mb.StartedKeys()
	if len(keys) == 0 {
		t.Fatal("expected run to start")
	}
	opts, _ := mb.GetStarted(keys[0])
	if opts.Prompt != "Scaffold a new extension called my-ext" {
		t.Errorf("prompt mismatch: %q", opts.Prompt)
	}
}

// ─── JS fallback: loads index.js when no main or index.ts ───

func TestExtensionFallbackToJS(t *testing.T) {
	extDir := t.TempDir()
	jsCode := `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const req = JSON.parse(line.trim());
  if (req.method === "init") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [], commands: {} } }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }) + "\n");
  }
});
`
	os.WriteFile(filepath.Join(extDir, "index.js"), []byte(jsCode), 0644)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(extDir, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load JS extension: %v", err)
	}

	tools := host.Tools()
	if len(tools) != 0 {
		t.Errorf("expected 0 tools, got %d", len(tools))
	}
}

// ─── TS priority: index.ts chosen over index.js ───

func TestTSPriorityOverJS(t *testing.T) {
	requireEsbuild(t)

	extDir := t.TempDir()

	tsCode := `import * as readline from "readline";
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line: string) => {
  const req = JSON.parse(line.trim());
  const result = req.method === "init"
    ? { tools: [{ name: "from_ts", description: "TS tool", parameters: {} }], commands: {} }
    : null;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
});
`
	jsCode := `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const req = JSON.parse(line.trim());
  const result = req.method === "init"
    ? { tools: [{ name: "from_js", description: "JS tool", parameters: {} }], commands: {} }
    : null;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
});
`
	os.WriteFile(filepath.Join(extDir, "index.ts"), []byte(tsCode), 0644)
	os.WriteFile(filepath.Join(extDir, "index.js"), []byte(jsCode), 0644)

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(extDir, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: "/tmp",
	}); err != nil {
		t.Fatalf("Load: %v", err)
	}

	tools := host.Tools()
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	if tools[0].Name != "from_ts" {
		t.Errorf("expected TS to win, got tool %q", tools[0].Name)
	}
}
