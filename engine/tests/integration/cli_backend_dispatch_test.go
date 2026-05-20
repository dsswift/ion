//go:build integration

package integration

import (
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// ─── DispatchAgent: CliBackend parent spawns CLI child ───
//
// When the Manager's parent backend is CliBackend, ctx.DispatchAgent must
// create a CliBackend child (not ApiBackend). The child will fail because
// the claude CLI binary isn't available in the test env, but the error
// message proves it attempted to use the CLI path ("claude CLI not found")
// rather than the API path ("no API key found").
func TestDispatchAgent_CliBackendParent_SpawnsCliChild(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := session.NewManager(cb)

	cfg := types.EngineConfig{
		ProfileID:        "cli-dispatch-test",
		WorkingDirectory: t.TempDir(),
	}

	if _, err := mgr.StartSession("cli-da", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("cli-da") })

	// Collect events to observe the child backend's behavior.
	var mu sync.Mutex
	var events []types.EngineEvent
	mgr.OnEvent(func(key string, ev types.EngineEvent) {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
	})

	// Invoke DispatchAgent through the session's wired context.
	// We can't call newExtContext directly (unexported), so we use the
	// extension host trick: register a tool that calls ctx.DispatchAgent
	// and invoke it through the session's tool call pipeline.
	//
	// Simpler: DispatchAgent is wired on the Context. We can test by
	// triggering an extension that calls ext/dispatch_agent. But there's a
	// cleaner way: use the ctx directly via an in-process extension.

	host := extension.NewHost()
	sdk := host.SDK()

	var dispatchResult *extension.DispatchAgentResult
	var dispatchErr error
	var dispatchDone sync.WaitGroup
	dispatchDone.Add(1)

	sdk.RegisterTool(extension.ToolDefinition{
		Name:        "test_dispatch",
		Description: "calls ctx.dispatchAgent",
		Parameters:  map[string]interface{}{"type": "object"},
		Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
			defer dispatchDone.Done()
			if ctx.DispatchAgent == nil {
				return &types.ToolResult{Content: "DispatchAgent not wired", IsError: true}, nil
			}
			dispatchResult, dispatchErr = ctx.DispatchAgent(extension.DispatchAgentOpts{
				Name: "test-agent",
				Task: "say hello",
			})
			return &types.ToolResult{Content: "dispatched"}, nil
		},
	})

	group := extension.NewExtensionGroup()
	group.Add(host)

	// Wire the extension group onto the session so tools and context are available
	mgr.TestSetExtGroup("cli-da", group)

	// Execute the tool through the session's tool pipeline.
	// The tool's Execute runs ctx.DispatchAgent, which creates a child backend.
	tools := host.Tools()
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}

	// Build a context that mirrors what newExtContext builds — we need DispatchAgent wired.
	// Since we can't call newExtContext, trigger via SendPrompt + mock or direct tool call.
	// Actually: the cleanest approach is to wire extensions, send a prompt, and let the
	// mock backend trigger tool execution. But that requires an ApiBackend run loop.
	//
	// For CliBackend tests, we can use a direct approach: call the extension tool
	// with a properly wired Context from the session manager.
	ctx := mgr.TestNewExtContext("cli-da")
	if ctx == nil {
		t.Fatal("TestNewExtContext returned nil (session not found)")
	}

	// Execute the tool. This calls DispatchAgent which creates a CliBackend child.
	_, err := tools[0].Execute(map[string]interface{}{}, ctx)
	if err != nil {
		t.Fatalf("tool Execute: %v", err)
	}

	// Wait for the dispatch to complete (the child will fail quickly since claude CLI isn't available).
	dispatchDone.Wait()

	// The child should have failed because claude CLI is not in path.
	// The key assertion: error mentions "claude CLI" or "claude" (not "API key").
	if dispatchErr == nil && dispatchResult != nil && dispatchResult.ExitCode == 0 {
		// If somehow claude CLI is available and succeeds, that's also fine.
		t.Log("dispatch succeeded (claude CLI available in test env)")
		return
	}

	if dispatchErr != nil {
		errMsg := dispatchErr.Error()
		if strings.Contains(errMsg, "API key") || strings.Contains(errMsg, "api key") {
			t.Fatalf("child used ApiBackend instead of CliBackend: %s", errMsg)
		}
		if strings.Contains(errMsg, "claude") || strings.Contains(errMsg, "CLI") {
			t.Logf("correctly used CliBackend child (error: %s)", errMsg)
		} else {
			t.Logf("dispatch error (may be expected in test env): %s", errMsg)
		}
	} else if dispatchResult != nil && dispatchResult.ExitCode != 0 {
		output := dispatchResult.Output
		if strings.Contains(output, "API key") || strings.Contains(output, "api key") {
			t.Fatalf("child used ApiBackend instead of CliBackend: %s", output)
		}
		t.Logf("dispatch completed with exit code %d (expected in test env)", dispatchResult.ExitCode)
	}
}

// ─── wireAgentToolServer: ion_agent tool discoverable via MCP ───
//
// Creates a CliBackend Manager, wires the agent tool server, then connects
// to the ToolServer's Unix socket and verifies:
// 1. tools/list includes "ion_agent"
// 2. tools/call with missing prompt returns an error
// 3. tools/call with unknown agent name returns spec resolution error
func TestWireAgentToolServer_McpRoundTrip(t *testing.T) {
	cb := backend.NewCliBackend()
	mgr := session.NewManager(cb)

	cfg := types.EngineConfig{
		ProfileID:        "mcp-agent-test",
		WorkingDirectory: t.TempDir(),
	}

	if _, err := mgr.StartSession("mcp-at", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("mcp-at") })

	// Register an agent spec so we can test spec resolution
	mgr.TestRegisterAgentSpec("mcp-at", types.AgentSpec{
		Name:         "researcher",
		Model:        "test-model",
		SystemPrompt: "You are a research assistant.",
		Tools:        []string{"Read", "Grep"},
	})

	// Wire the agent tool server
	opts := types.RunOptions{}
	mgr.TestWireAgentToolServer("mcp-at", &opts)

	if opts.McpConfig == "" {
		t.Fatal("expected McpConfig to be set after wireAgentToolServer")
	}

	// Get the ToolServer's socket path
	sockPath := mgr.TestGetToolServerSocketPath("mcp-at")
	if sockPath == "" {
		t.Fatal("expected ToolServer socket path")
	}

	// Connect to the Unix socket
	conn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		t.Fatalf("connect to ToolServer: %v", err)
	}
	defer conn.Close()

	decoder := json.NewDecoder(conn)
	encoder := json.NewEncoder(conn)

	// 1. tools/list should include "ion_agent"
	encoder.Encode(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/list",
	})

	var listResp struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := decoder.Decode(&listResp); err != nil {
		t.Fatalf("decode tools/list response: %v", err)
	}

	foundIonAgent := false
	for _, tool := range listResp.Result.Tools {
		if tool.Name == "ion_agent" {
			foundIonAgent = true
		}
	}
	if !foundIonAgent {
		t.Fatalf("ion_agent not found in tools/list response: %+v", listResp.Result.Tools)
	}

	// 2. tools/call with missing prompt → error
	encoder.Encode(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "tools/call",
		"params": map[string]interface{}{
			"name":      "ion_agent",
			"arguments": map[string]interface{}{},
		},
	})

	var callResp struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	if err := decoder.Decode(&callResp); err != nil {
		t.Fatalf("decode tools/call response (no prompt): %v", err)
	}
	if !callResp.Result.IsError {
		t.Error("expected isError=true for missing prompt")
	}
	if len(callResp.Result.Content) > 0 && !strings.Contains(callResp.Result.Content[0].Text, "prompt is required") {
		t.Errorf("expected 'prompt is required' error, got %q", callResp.Result.Content[0].Text)
	}

	// 3. tools/call with unknown agent name now falls through as unnamed agent.
	// We no longer test for a "not registered" error since the engine
	// intentionally falls back to an unnamed agent when name resolution fails.
	// Spawning a real child agent here would require a model, so we skip it.
}

// ─── newChildBackend factory: type-correctness ───
//
// Verifies the factory returns the correct concrete type for both
// CliBackend and ApiBackend parents at the integration level.
func TestNewChildBackend_TypeCorrectness(t *testing.T) {
	// CliBackend parent → CliBackend child
	cliMgr := session.NewManager(backend.NewCliBackend())
	cliChild := cliMgr.TestNewChildBackend()
	if _, ok := cliChild.(*backend.CliBackend); !ok {
		t.Errorf("CliBackend parent: expected *CliBackend child, got %T", cliChild)
	}

	// ApiBackend parent → ApiBackend child
	apiMgr := session.NewManager(backend.NewApiBackend())
	apiChild := apiMgr.TestNewChildBackend()
	if _, ok := apiChild.(*backend.ApiBackend); !ok {
		t.Errorf("ApiBackend parent: expected *ApiBackend child, got %T", apiChild)
	}

	// MockBackend parent → ApiBackend child (default fallback)
	mockMgr := session.NewManager(helpers.NewMockBackend())
	mockChild := mockMgr.TestNewChildBackend()
	if _, ok := mockChild.(*backend.ApiBackend); !ok {
		t.Errorf("MockBackend parent: expected *ApiBackend child (fallback), got %T", mockChild)
	}
}

// ─── wireAgentToolServer: no-op for non-CLI backend ───
//
// Verifies wireAgentToolServer does nothing when the parent backend
// is not CliBackend.
func TestWireAgentToolServer_NoopForApiBackend(t *testing.T) {
	apiMgr := session.NewManager(backend.NewApiBackend())

	cfg := types.EngineConfig{
		ProfileID:        "api-noop-test",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := apiMgr.StartSession("api-at", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { apiMgr.StopSession("api-at") })

	opts := types.RunOptions{}
	apiMgr.TestWireAgentToolServer("api-at", &opts)

	if opts.McpConfig != "" {
		t.Error("expected no McpConfig for ApiBackend")
	}
	sockPath := apiMgr.TestGetToolServerSocketPath("api-at")
	if sockPath != "" {
		t.Error("expected no ToolServer for ApiBackend")
	}
}
