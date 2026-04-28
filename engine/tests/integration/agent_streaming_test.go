//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/server"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// ─── Agent Spawner Tests ───

func TestAgentSpawnerChildRunCompletes(t *testing.T) {
	mp := setupMockProvider(t)

	// Parent: first call returns Agent tool_use, second call returns text
	mp.SetResponse(helpers.ToolCallResponse("Agent", "tool_agent_001", map[string]interface{}{
		"prompt": "do child work",
	}))
	mp.SetResponse(helpers.TextResponse("parent done"))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	// Wire agent spawner: child runs synchronously with its own provider
	childProvider := helpers.NewMockProvider("child-mock")
	childProvider.SetResponse(helpers.TextResponse("child output text"))
	providers.RegisterProvider(childProvider)
	providers.RegisterModel("child-model", types.ModelInfo{
		ProviderID:    "child-mock",
		ContextWindow: 200000,
	})

	tools.SetAgentSpawner(func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		// Create a child backend, run synchronously, collect result
		child := backend.NewApiBackend()
		var result string
		var childDone sync.WaitGroup
		childDone.Add(1)

		child.OnNormalized(func(_ string, ev types.NormalizedEvent) {
			if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
				result = tc.Result
			}
		})
		child.OnExit(func(_ string, _ *int, _ *string, _ string) {
			childDone.Done()
		})
		child.OnError(func(_ string, _ error) {})

		child.StartRun("child-run", types.RunOptions{
			Prompt: prompt,
			Model:  "child-model",
		})
		childDone.Wait()
		return result, nil
	})
	defer tools.SetAgentSpawner(nil)

	b.StartRun("parent-run", types.RunOptions{
		Prompt: "spawn agent",
		Model:  "mock-model",
	})

	be.waitForExit(t, 10*time.Second)

	events := be.getNormalized()

	// Verify parent got tool call for Agent and completed
	var foundAgentCall, foundComplete bool
	for _, ev := range events {
		switch e := ev.Data.(type) {
		case *types.ToolCallEvent:
			if e.ToolName == "Agent" {
				foundAgentCall = true
			}
		case *types.TaskCompleteEvent:
			foundComplete = true
		}
	}

	if !foundAgentCall {
		t.Error("missing Agent tool_call event")
	}
	if !foundComplete {
		t.Error("missing task_complete event")
	}
}

func TestAgentSpawnerConcurrentChildRuns(t *testing.T) {
	mp := setupMockProvider(t)

	// Parent: two concurrent Agent tool calls, then final text
	// Build a response with two tool_use blocks
	stopReason := "tool_use"
	twoToolResponse := []types.LlmStreamEvent{
		{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID: "msg_multi", Model: "mock-model",
				Usage: types.LlmUsage{InputTokens: 10},
			},
		},
		{
			Type: "content_block_start", BlockIndex: 0,
			ContentBlock: &types.LlmStreamContentBlock{Type: "tool_use", ID: "tool_agent_a", Name: "Agent"},
		},
		{
			Type: "content_block_delta", BlockIndex: 0,
			Delta: &types.LlmStreamDelta{Type: "input_json_delta", PartialJSON: `{"prompt":"task alpha"}`},
		},
		{Type: "content_block_stop", BlockIndex: 0},
		{
			Type: "content_block_start", BlockIndex: 1,
			ContentBlock: &types.LlmStreamContentBlock{Type: "tool_use", ID: "tool_agent_b", Name: "Agent"},
		},
		{
			Type: "content_block_delta", BlockIndex: 1,
			Delta: &types.LlmStreamDelta{Type: "input_json_delta", PartialJSON: `{"prompt":"task beta"}`},
		},
		{Type: "content_block_stop", BlockIndex: 1},
		{
			Type: "message_delta",
			Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason},
			DeltaUsage: &types.LlmUsage{OutputTokens: 10},
		},
		{Type: "message_stop"},
	}
	mp.SetResponse(twoToolResponse)
	mp.SetResponse(helpers.TextResponse("both done"))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	var mu sync.Mutex
	var prompts []string

	tools.SetAgentSpawner(func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		mu.Lock()
		prompts = append(prompts, prompt)
		mu.Unlock()
		return "result-for-" + prompt, nil
	})
	defer tools.SetAgentSpawner(nil)

	b.StartRun("parent-concurrent", types.RunOptions{
		Prompt: "run two agents",
		Model:  "mock-model",
	})

	be.waitForExit(t, 10*time.Second)

	mu.Lock()
	defer mu.Unlock()

	if len(prompts) != 2 {
		t.Fatalf("expected 2 agent spawns, got %d", len(prompts))
	}

	// Both prompts should be present (order not guaranteed due to parallelism)
	foundAlpha, foundBeta := false, false
	for _, p := range prompts {
		if strings.Contains(p, "alpha") {
			foundAlpha = true
		}
		if strings.Contains(p, "beta") {
			foundBeta = true
		}
	}
	if !foundAlpha || !foundBeta {
		t.Errorf("expected both alpha and beta prompts, got %v", prompts)
	}
}

func TestAgentSpawnerChildError(t *testing.T) {
	mp := setupMockProvider(t)

	mp.SetResponse(helpers.ToolCallResponse("Agent", "tool_agent_err", map[string]interface{}{
		"prompt": "fail please",
	}))
	mp.SetResponse(helpers.TextResponse("recovered"))

	b := backend.NewApiBackend()
	be := newBackendCollector(b)

	tools.SetAgentSpawner(func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		return "", fmt.Errorf("child crashed")
	})
	defer tools.SetAgentSpawner(nil)

	b.StartRun("parent-err", types.RunOptions{
		Prompt: "spawn failing agent",
		Model:  "mock-model",
	})

	be.waitForExit(t, 10*time.Second)

	events := be.getNormalized()

	// Should have tool_result with IsError=true, and parent should complete
	var foundErrorResult, foundComplete bool
	for _, ev := range events {
		switch e := ev.Data.(type) {
		case *types.ToolResultEvent:
			if e.IsError && strings.Contains(e.Content, "Agent error") {
				foundErrorResult = true
			}
		case *types.TaskCompleteEvent:
			foundComplete = true
		}
	}

	if !foundErrorResult {
		t.Error("missing error tool_result from failed agent child")
	}
	if !foundComplete {
		t.Error("parent should complete even after child error")
	}
}

// ─── AgentStateUpdate Round-trip ───

func TestAgentStateHierarchyRoundTrip(t *testing.T) {
	state := types.AgentStateUpdate{
		Name:   "worker-1",
		Status: "running",
		Metadata: map[string]interface{}{
			"displayName": "Code Worker",
			"type":        "agent",
			"visibility":  "visible",
			"parentAgent": "coordinator",
			"depth":       float64(2),
		},
	}

	data, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded types.AgentStateUpdate
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Name != "worker-1" {
		t.Errorf("Name: want worker-1, got %s", decoded.Name)
	}
	if decoded.Status != "running" {
		t.Errorf("Status: want running, got %s", decoded.Status)
	}
	pa, _ := decoded.Metadata["parentAgent"].(string)
	if pa != "coordinator" {
		t.Errorf("Metadata[parentAgent]: want coordinator, got %s", pa)
	}
	depth, _ := decoded.Metadata["depth"].(float64)
	if depth != 2 {
		t.Errorf("Metadata[depth]: want 2, got %v", depth)
	}
	dn, _ := decoded.Metadata["displayName"].(string)
	if dn != "Code Worker" {
		t.Errorf("Metadata[displayName]: want Code Worker, got %s", dn)
	}
}

// ─── Protocol: abort_agent / steer_agent ───

func TestProtocolAbortAgent(t *testing.T) {
	sockPath := agentSockPath(t, "abort")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	// Start session + register mock agent handle
	conn := dialSock(t, sockPath)
	defer conn.Close()

	agentSendCmd(t, conn, map[string]interface{}{
		"cmd": "start_session",
		"key": "s1",
		"config": map[string]interface{}{
			"profileId":        "test",
			"extensionDir":     "",
			"workingDirectory": t.TempDir(),
		},
	})
	drainEvents(conn, 500*time.Millisecond)

	// Send abort_agent command
	agentSendCmd(t, conn, map[string]interface{}{
		"cmd":       "abort_agent",
		"key":       "s1",
		"agentName": "test-agent",
	})

	// abort_agent is fire-and-forget, no response expected.
	// Just verify no crash occurred by sending another command.
	agentSendCmd(t, conn, map[string]interface{}{
		"cmd": "stop_session",
		"key": "s1",
	})
	drainEvents(conn, 500*time.Millisecond)
}

func TestProtocolSteerAgent(t *testing.T) {
	sockPath := agentSockPath(t, "steer")
	mb := helpers.NewMockBackend()
	srv := server.NewServer(sockPath, mb)

	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })

	conn := dialSock(t, sockPath)
	defer conn.Close()

	agentSendCmd(t, conn, map[string]interface{}{
		"cmd": "start_session",
		"key": "s1",
		"config": map[string]interface{}{
			"profileId":        "test",
			"extensionDir":     "",
			"workingDirectory": t.TempDir(),
		},
	})
	drainEvents(conn, 500*time.Millisecond)

	// Send steer_agent command
	agentSendCmd(t, conn, map[string]interface{}{
		"cmd":       "steer_agent",
		"key":       "s1",
		"agentName": "test-agent",
		"message":   "focus on tests",
	})

	// steer_agent is fire-and-forget. Verify no crash.
	agentSendCmd(t, conn, map[string]interface{}{
		"cmd": "stop_session",
		"key": "s1",
	})
	drainEvents(conn, 500*time.Millisecond)
}

// ─── Helpers ───

func agentSockPath(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ion")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, fmt.Sprintf("%s.sock", name))
}

func dialSock(t *testing.T, path string) net.Conn {
	t.Helper()
	var conn net.Conn
	var err error
	for i := 0; i < 20; i++ {
		conn, err = net.Dial("unix", path)
		if err == nil {
			return conn
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("dial %s: %v", path, err)
	return nil
}

func agentSendCmd(t *testing.T, conn net.Conn, cmd map[string]interface{}) {
	t.Helper()
	data, err := json.Marshal(cmd)
	if err != nil {
		t.Fatalf("marshal cmd: %v", err)
	}
	data = append(data, '\n')
	conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write(data); err != nil {
		t.Fatalf("write cmd: %v", err)
	}
}

func drainEvents(conn net.Conn, timeout time.Duration) []string {
	conn.SetReadDeadline(time.Now().Add(timeout))
	var lines []string
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			for _, line := range strings.Split(string(buf[:n]), "\n") {
				if line != "" {
					lines = append(lines, line)
				}
			}
		}
		if err != nil {
			break
		}
	}
	return lines
}

// Ensure imports are used
var _ = protocol.ParseClientCommand
var _ = providers.ResetRegistries
