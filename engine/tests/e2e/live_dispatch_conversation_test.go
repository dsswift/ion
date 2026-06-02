//go:build e2e

package e2e

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
)

// dispatchSpec describes a single dispatch to execute.
type dispatchSpec struct {
	agentName      string
	task           string
	expectedAnswer string
}

// dispatchOutcome captures the result of a single dispatch.
type dispatchOutcome struct {
	spec   dispatchSpec
	result *extension.DispatchAgentResult
	err    error
}

// TestLiveMultiAgentDispatchConversation verifies conversation integrity across
// multiple agents dispatched multiple times via the extension dispatch path
// (ctx.DispatchAgent). This is the code path used by ion-meta and other
// extensions, as opposed to the LLM-initiated spawner path.
//
// The test dispatches 4 agents (2 names × 2 dispatches each) with trivially
// verifiable tasks. After all dispatches complete, it asserts:
//   - Each dispatch produced a non-empty SessionID and exit code 0.
//   - Each child conversation contains the correct task text (no cross-talk).
//   - Each child conversation has an assistant reply with the expected answer.
//   - The agent state's "dispatches" metadata array has the right count and
//     each entry's conversationId matches the actual SessionID.
func TestLiveMultiAgentDispatchConversation(t *testing.T) {
	model := setupAnthropicProvider(t)

	parentBackend := backend.NewApiBackend()
	mgr := session.NewManager(parentBackend)

	cfg := types.EngineConfig{
		ProfileID:        "e2e-multi-dispatch",
		WorkingDirectory: t.TempDir(),
	}

	mgr.SetConfig(&types.EngineRuntimeConfig{
		DefaultModel: model,
	})

	if _, err := mgr.StartSession("e2e-md", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession("e2e-md") })

	// Collect engine events emitted by the manager for agent state assertions.
	var eventMu sync.Mutex
	var agentStateEvents []types.EngineEvent
	mgr.OnEvent(func(key string, ev types.EngineEvent) {
		if ev.Type == "engine_agent_state" {
			eventMu.Lock()
			agentStateEvents = append(agentStateEvents, ev)
			eventMu.Unlock()
		}
	})

	// Define the 4 dispatches: 2 agents × 2 dispatches each.
	specs := []dispatchSpec{
		{"math-agent", "What is 7 * 8? Reply with ONLY the number.", "56"},
		{"math-agent", "What is 13 + 29? Reply with ONLY the number.", "42"},
		{"trivia-agent", "What is the capital of Japan? Reply with ONLY the city name.", "Tokyo"},
		{"trivia-agent", "What is the chemical symbol for gold? Reply with ONLY the symbol.", "Au"},
	}

	// Create an extension tool that dispatches all 4 agents sequentially.
	// Sequential dispatch within each agent name tests the re-dispatch /
	// coalescing path (AppendOrUpdate hits the update branch on the second
	// dispatch of the same agent name).
	host := extension.NewHost()
	sdk := host.SDK()

	outcomes := make([]dispatchOutcome, len(specs))
	dispatchDone := make(chan struct{})

	sdk.RegisterTool(extension.ToolDefinition{
		Name:        "run_dispatches",
		Description: "dispatches multiple agents sequentially",
		Parameters:  map[string]interface{}{"type": "object"},
		Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
			defer close(dispatchDone)
			for i, spec := range specs {
				t.Logf("dispatching [%d] agent=%s task=%q", i, spec.agentName, spec.task)
				result, err := ctx.DispatchAgent(extension.DispatchAgentOpts{
					Name:     spec.agentName,
					Task:     spec.task,
					MaxTurns: 1,
				})
				outcomes[i] = dispatchOutcome{spec: spec, result: result, err: err}
				if err != nil {
					t.Logf("dispatch [%d] error: %v", i, err)
				} else {
					t.Logf("dispatch [%d] done: sessionID=%s exitCode=%d",
						i, result.SessionID, result.ExitCode)
				}
			}
			return &types.ToolResult{Content: "all dispatched"}, nil
		},
	})

	group := extension.NewExtensionGroup()
	group.Add(host)
	mgr.TestSetExtGroup("e2e-md", group)

	// Get the wired context and invoke the tool.
	ctx := mgr.TestNewExtContext("e2e-md")
	if ctx == nil {
		t.Fatal("TestNewExtContext returned nil")
	}

	tools := host.Tools()
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}

	_, err := tools[0].Execute(map[string]interface{}{}, ctx)
	if err != nil {
		t.Fatalf("tool Execute: %v", err)
	}

	// Wait for all dispatches to finish.
	select {
	case <-dispatchDone:
	case <-time.After(300 * time.Second):
		t.Fatal("dispatches timed out after 300s")
	}

	// ─── Assertion block A: dispatch results ──────────────────────────────
	for i, o := range outcomes {
		if o.err != nil {
			t.Fatalf("[%d] dispatch error: %v", i, o.err)
		}
		if o.result == nil {
			t.Fatalf("[%d] dispatch returned nil result", i)
		}
		if o.result.SessionID == "" {
			t.Errorf("[%d] dispatch returned empty SessionID", i)
		}
		if o.result.ExitCode != 0 {
			t.Errorf("[%d] dispatch exit code %d, output: %s",
				i, o.result.ExitCode, o.result.Output)
		}
		t.Logf("[%d] agent=%s sessionID=%s exitCode=%d cost=%.6f",
			i, o.spec.agentName, o.result.SessionID, o.result.ExitCode, o.result.Cost)
	}

	// ─── Assertion block B: conversation content ──────────────────────────
	for i, o := range outcomes {
		if o.result == nil || o.result.SessionID == "" {
			continue
		}
		conv, err := conversation.Load(o.result.SessionID, "")
		if err != nil {
			t.Errorf("[%d] failed to load conversation %s: %v", i, o.result.SessionID, err)
			continue
		}
		if len(conv.Messages) < 2 {
			t.Errorf("[%d] expected at least 2 messages, got %d", i, len(conv.Messages))
			continue
		}

		// Verify user message contains the dispatched task text.
		foundTask := false
		for _, msg := range conv.Messages {
			if msg.Role == "user" {
				text := extractMessageText(msg)
				if strings.Contains(text, o.spec.task) {
					foundTask = true
					break
				}
			}
		}
		if !foundTask {
			t.Errorf("[%d] user message does not contain task %q", i, o.spec.task)
		}

		// Verify assistant replied with the expected answer.
		foundAnswer := false
		for _, msg := range conv.Messages {
			if msg.Role == "assistant" {
				text := extractMessageText(msg)
				if strings.Contains(text, o.spec.expectedAnswer) {
					foundAnswer = true
					break
				}
			}
		}
		if !foundAnswer {
			t.Errorf("[%d] assistant reply does not contain expected answer %q",
				i, o.spec.expectedAnswer)
		}
	}

	// ─── Assertion block C: no interleaving ───────────────────────────────
	// For each dispatch, verify its conversation does NOT contain another
	// dispatch's task text. This catches the bug where conversationIds get
	// jumbled between agents.
	for i, o := range outcomes {
		if o.result == nil || o.result.SessionID == "" {
			continue
		}
		conv, err := conversation.Load(o.result.SessionID, "")
		if err != nil {
			continue // already reported in block B
		}
		for j, other := range outcomes {
			if i == j {
				continue
			}
			for _, msg := range conv.Messages {
				if msg.Role == "user" {
					text := extractMessageText(msg)
					if strings.Contains(text, other.spec.task) {
						t.Errorf("[%d] conversation contains task text from dispatch [%d] (%q) — conversations are interleaved",
							i, j, other.spec.task)
					}
				}
			}
		}
	}

	// ─── Assertion block D: dispatches metadata ───────────────────────────
	// The last engine_agent_state event should have the full agent state with
	// dispatches arrays. Each agent name should have the correct number of
	// dispatch entries, and each entry's conversationId should match the
	// actual SessionID from the corresponding DispatchAgentResult.
	eventMu.Lock()
	lastAgentState := agentStateEvents[len(agentStateEvents)-1]
	eventMu.Unlock()

	// Build lookup: agentName → expected dispatch entries (ordered).
	type expectedDispatch struct {
		task      string
		sessionID string
	}
	expected := map[string][]expectedDispatch{}
	for _, o := range outcomes {
		if o.result != nil {
			expected[o.spec.agentName] = append(expected[o.spec.agentName], expectedDispatch{
				task:      o.spec.task,
				sessionID: o.result.SessionID,
			})
		}
	}

	for _, agent := range lastAgentState.Agents {
		exp, ok := expected[agent.Name]
		if !ok {
			continue
		}

		dispatches, ok := agent.Metadata["dispatches"].([]interface{})
		if !ok {
			t.Errorf("agent %q has no dispatches array in metadata", agent.Name)
			continue
		}

		if len(dispatches) != len(exp) {
			t.Errorf("agent %q: expected %d dispatches, got %d",
				agent.Name, len(exp), len(dispatches))
			continue
		}

		for idx, d := range dispatches {
			dm, ok := d.(map[string]interface{})
			if !ok {
				t.Errorf("agent %q dispatch[%d]: not a map", agent.Name, idx)
				continue
			}
			convID, _ := dm["conversationId"].(string)
			if convID == "" {
				t.Errorf("agent %q dispatch[%d]: missing conversationId", agent.Name, idx)
			} else if convID != exp[idx].sessionID {
				t.Errorf("agent %q dispatch[%d]: conversationId=%q, want %q",
					agent.Name, idx, convID, exp[idx].sessionID)
			}

			task, _ := dm["task"].(string)
			if task != exp[idx].task {
				t.Errorf("agent %q dispatch[%d]: task=%q, want %q",
					agent.Name, idx, task, exp[idx].task)
			}

			status, _ := dm["status"].(string)
			if status != "done" {
				t.Errorf("agent %q dispatch[%d]: status=%q, want %q",
					agent.Name, idx, status, "done")
			}
		}
	}
}

// extractMessageText returns the concatenated text content of an LlmMessage.
// Content can be a string, []LlmContentBlock, or (after JSON round-trip)
// []interface{} of map[string]interface{}.
func extractMessageText(msg types.LlmMessage) string {
	switch c := msg.Content.(type) {
	case string:
		return c
	case []types.LlmContentBlock:
		var sb strings.Builder
		for _, block := range c {
			if block.Type == "text" {
				sb.WriteString(block.Text)
			}
		}
		return sb.String()
	case []interface{}:
		var sb strings.Builder
		for _, item := range c {
			if m, ok := item.(map[string]interface{}); ok {
				if t, _ := m["type"].(string); t == "text" {
					if text, _ := m["text"].(string); text != "" {
						sb.WriteString(text)
					}
				}
			}
		}
		return sb.String()
	default:
		return ""
	}
}
