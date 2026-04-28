//go:build integration

package integration

import (
	"encoding/json"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// ─── Helpers ───

func ionCanaryEntry(t *testing.T) string {
	t.Helper()
	repoDir := filepath.Join("..", "..", "extensions", "ion-canary")
	abs, err := filepath.Abs(filepath.Join(repoDir, "index.ts"))
	if err != nil {
		t.Fatalf("resolve canary path: %v", err)
	}
	return abs
}

func loadCanary(t *testing.T) *extension.Host {
	t.Helper()
	requireEsbuild(t)
	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(ionCanaryEntry(t), &extension.ExtensionConfig{
		ExtensionDir:     filepath.Dir(ionCanaryEntry(t)),
		WorkingDirectory: t.TempDir(),
	}); err != nil {
		t.Fatalf("load ion-canary: %v", err)
	}
	return host
}

func findTool(t *testing.T, host *extension.Host, name string) extension.ToolDefinition {
	t.Helper()
	for _, tool := range host.Tools() {
		if tool.Name == name {
			return tool
		}
	}
	t.Fatalf("tool %q not registered; got: %v", name, toolNames(host.Tools()))
	return extension.ToolDefinition{}
}

// ─── Test 1: typed_payload compile + tool registration ───

func TestCanary_TypedPayloadCompiles(t *testing.T) {
	host := loadCanary(t)
	// If the .ts failed to compile (typed payloads broken), Load would have
	// errored. Confirm the expected tools registered.
	for _, want := range []string{
		"canary_classify_tier", "canary_promote", "canary_elicit",
		"canary_sandbox", "canary_typed_check",
	} {
		findTool(t, host, want)
	}

	// Invoke the typed_check tool to round-trip the SDK init handshake.
	tool := findTool(t, host, "canary_typed_check")
	ctx := &extension.Context{Cwd: "/tmp"}
	result, err := tool.Execute(map[string]any{}, ctx)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(result.Content, "typed_payloads_compile_ok") {
		t.Errorf("unexpected content: %q", result.Content)
	}
}

// ─── Test 2: permission_classify wire round-trip ───

func TestCanary_PermissionClassifyRoundTrip(t *testing.T) {
	host := loadCanary(t)

	ctx := &extension.Context{Cwd: "/tmp"}
	tier := host.SDK().FirePermissionClassify(ctx, extension.PermissionClassifyInfo{
		ToolName: "Bash",
		Input:    map[string]interface{}{"command": "rm -rf /"},
	})
	if tier != "CRITICAL" {
		t.Errorf("expected tier=CRITICAL through subprocess RPC, got %q", tier)
	}

	// Empty-string fallback: handler returns "" for the sentinel tool name.
	emptyTier := host.SDK().FirePermissionClassify(ctx, extension.PermissionClassifyInfo{
		ToolName: "__skip_classify__",
	})
	if emptyTier != "" {
		t.Errorf("expected empty tier (handler opted out), got %q", emptyTier)
	}
}

// ─── Test 3: capability_match -> ext/register_agent_spec round-trip ───

func TestCanary_CapabilityMatchRegistersSpec(t *testing.T) {
	host := loadCanary(t)

	// Step 1: queue a spec inside the extension via canary_promote.
	promote := findTool(t, host, "canary_promote")
	ctx := &extension.Context{Cwd: "/tmp"}
	result, err := promote.Execute(map[string]any{
		"spec": map[string]any{
			"name":         "travel-planner",
			"description":  "Plan trips",
			"model":        "claude-sonnet-4-6",
			"systemPrompt": "You plan trips.",
		},
	}, ctx)
	if err != nil || result.IsError {
		t.Fatalf("canary_promote: err=%v content=%q", err, result.Content)
	}

	// Step 2: wire RegisterAgentSpec on a fresh ctx so we can capture it.
	captured := make(chan types.AgentSpec, 1)
	hookCtx := &extension.Context{
		Cwd: "/tmp",
		RegisterAgentSpec: func(spec types.AgentSpec) {
			select {
			case captured <- spec:
			default:
			}
		},
	}

	// Step 3: fire capability_match. Subprocess handler reads queuedSpecs,
	// finds "travel-planner", calls ctx.registerAgentSpec via JSON-RPC
	// (ext/register_agent_spec), which routes back to hookCtx.RegisterAgentSpec.
	host.SDK().FireCapabilityMatch(hookCtx, extension.CapabilityMatchInfo{
		Input:        "travel-planner",
		Capabilities: []string{},
	})

	select {
	case spec := <-captured:
		if spec.Name != "travel-planner" {
			t.Errorf("unexpected spec.Name: %q", spec.Name)
		}
		if spec.Model != "claude-sonnet-4-6" {
			t.Errorf("unexpected spec.Model: %q", spec.Model)
		}
		if spec.SystemPrompt != "You plan trips." {
			t.Errorf("unexpected spec.SystemPrompt: %q", spec.SystemPrompt)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RegisterAgentSpec never fired through ext/register_agent_spec RPC")
	}
}

// ─── Test 4: ext/elicit round-trip with simulated client response ───

func TestCanary_ElicitRoundTrip(t *testing.T) {
	host := loadCanary(t)

	// Build a ctx whose Elicit closure mimics the session manager: emits
	// (no-op), then waits on a chan that the test controls. We send a
	// synthetic "client response" ourselves to prove the Promise resolves.
	type elicitArgs struct {
		info extension.ElicitationRequestInfo
	}
	calls := make(chan elicitArgs, 1)
	respond := make(chan map[string]interface{}, 1)
	cancelOut := make(chan bool, 1)

	ctx := &extension.Context{
		Cwd: "/tmp",
		Elicit: func(info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
			select {
			case calls <- elicitArgs{info: info}:
			default:
			}
			select {
			case resp := <-respond:
				return resp, false, nil
			case c := <-cancelOut:
				return nil, c, nil
			case <-time.After(2 * time.Second):
				return nil, true, nil
			}
		},
	}

	tool := findTool(t, host, "canary_elicit")
	var (
		toolResult *types.ToolResult
		toolErr    error
		toolDone   sync.WaitGroup
	)
	toolDone.Add(1)
	go func() {
		defer toolDone.Done()
		toolResult, toolErr = tool.Execute(map[string]any{
			"mode":   "approval",
			"schema": map[string]any{"action": "register_agent"},
		}, ctx)
	}()

	// Wait for the extension to call ctx.elicit().
	var args elicitArgs
	select {
	case args = <-calls:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx.elicit was never invoked")
	}
	if args.info.Mode != "approval" {
		t.Errorf("unexpected mode: %q", args.info.Mode)
	}
	if args.info.Schema["action"] != "register_agent" {
		t.Errorf("schema not propagated: %v", args.info.Schema)
	}

	// Send the simulated client response.
	respond <- map[string]interface{}{"decision": "accept", "comment": "ok"}

	toolDone.Wait()
	if toolErr != nil {
		t.Fatalf("tool err: %v", toolErr)
	}
	if toolResult.IsError {
		t.Fatalf("tool returned error: %s", toolResult.Content)
	}

	// The host pretty-prints the SDK's tool response object
	// `{content: "<inner JSON>"}`. Extract the inner JSON, then parse.
	var got struct {
		Response  map[string]interface{} `json:"response"`
		Cancelled bool                   `json:"cancelled"`
	}
	inner := unwrapToolContent(t, toolResult.Content)
	if err := json.Unmarshal([]byte(inner), &got); err != nil {
		t.Fatalf("parse inner: %v (inner=%q)", err, inner)
	}
	if got.Cancelled {
		t.Errorf("expected cancelled=false, got true")
	}
	if got.Response["decision"] != "accept" {
		t.Errorf("expected decision=accept, got %v (inner=%q)", got.Response["decision"], inner)
	}
}

// unwrapToolContent extracts the inner JSON from the host's pretty-printed
// `{content: "<inner JSON>"}` envelope around a subprocess tool's return.
func unwrapToolContent(t *testing.T, raw string) string {
	t.Helper()
	var envelope struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &envelope); err != nil {
		// No envelope; assume the raw value is already the inner JSON.
		return raw
	}
	if envelope.Content == "" {
		return raw
	}
	return envelope.Content
}

// ─── Test 5: ext/sandbox_wrap round-trip ───

func TestCanary_SandboxWrapRoundTrip(t *testing.T) {
	host := loadCanary(t)

	tool := findTool(t, host, "canary_sandbox")
	ctx := &extension.Context{Cwd: "/tmp"}
	result, err := tool.Execute(map[string]any{
		"command": "echo hello",
	}, ctx)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.IsError {
		t.Fatalf("tool returned error: %s", result.Content)
	}

	inner := unwrapToolContent(t, result.Content)
	var got struct {
		Wrapped  string `json:"wrapped"`
		Platform string `json:"platform"`
	}
	if err := json.Unmarshal([]byte(inner), &got); err != nil {
		t.Fatalf("parse tool result: %v (inner=%q)", err, inner)
	}
	if got.Platform == "" {
		t.Error("expected non-empty platform")
	}
	if got.Wrapped == "" {
		t.Error("expected non-empty wrapped command")
	}

	// macOS path: sandbox-exec wrapper. Linux path: bwrap. Anything else
	// returns the command unchanged.
	switch runtime.GOOS {
	case "darwin":
		if !strings.Contains(got.Wrapped, "sandbox-exec") {
			t.Errorf("macOS wrapper missing sandbox-exec: %q", got.Wrapped)
		}
	case "linux":
		if !strings.Contains(got.Wrapped, "bwrap") {
			t.Errorf("linux wrapper missing bwrap: %q", got.Wrapped)
		}
	}
}

// (Manager-level end-to-end resolveAgentSpec flow is covered by the unit test
//  TestResolveAgentSpec_CapabilityMatchPromotion in internal/session, which
//  uses an in-process host. The subprocess wire round-trip from
//  capability_match → ctx.registerAgentSpec is covered by Test 3 above.)
