package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// End-to-end coverage for the mode-invariant prompt prefix.
//
// A provider caches a prompt as a prefix: tools, then system prompt, then
// messages. These tests drive a real run through StartRunWithConfig, capture
// what the provider is handed on every call, and assert that the prefix does
// not change when the run's plan mode does.

// toolCapturingProvider records the tool list of every Stream call so a test
// can assert on the per-turn tool set rather than only the final one.
//
// Scripted responses are consumed in order, one per call, mirroring
// mockLlmProvider. A separate type (rather than a field on mockLlmProvider)
// keeps the capture allocation off every other backend test.
type toolCapturingProvider struct {
	id        string
	mu        sync.Mutex
	callCount int
	responses [][]types.LlmStreamEvent
	// toolsPerCall[i] holds the tool names passed on Stream call i.
	toolsPerCall [][]string
	// optsPerCall[i] holds the request passed on Stream call i, with the tool
	// and message slices copied so later turns cannot alter the record.
	optsPerCall []types.LlmStreamOptions
}

func (m *toolCapturingProvider) ID() string { return m.id }

func (m *toolCapturingProvider) CountTokens(_ context.Context, _ providers.CountTokensRequest) (int, error) {
	return 0, providers.ErrCountUnsupported
}

func (m *toolCapturingProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 32)
	errc := make(chan error, 1)

	names := make([]string, 0, len(opts.Tools))
	for _, td := range opts.Tools {
		names = append(names, td.Name)
	}

	m.mu.Lock()
	idx := m.callCount
	m.callCount++
	m.toolsPerCall = append(m.toolsPerCall, names)
	captured := opts
	captured.Tools = append([]types.LlmToolDef(nil), opts.Tools...)
	captured.Messages = append([]types.LlmMessage(nil), opts.Messages...)
	m.optsPerCall = append(m.optsPerCall, captured)
	m.mu.Unlock()

	go func() {
		defer close(events)
		defer close(errc)
		if idx >= len(m.responses) {
			errc <- fmt.Errorf("tool-capturing provider: no response for call %d", idx)
			return
		}
		for _, ev := range m.responses[idx] {
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

// toolsForCall returns the captured tool names for a given Stream call index.
func (m *toolCapturingProvider) toolsForCall(i int) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if i >= len(m.toolsPerCall) {
		return nil
	}
	return m.toolsPerCall[i]
}

// requestForCall returns the captured request for a given Stream call index.
func (m *toolCapturingProvider) requestForCall(i int) types.LlmStreamOptions {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.optsPerCall[i]
}

func (m *toolCapturingProvider) callsMade() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.toolsPerCall)
}

// setupToolCapturingProvider registers a tool-capturing provider under the
// shared test model id, mirroring setupTestProvider.
func setupToolCapturingProvider(responses [][]types.LlmStreamEvent) *toolCapturingProvider {
	mock := &toolCapturingProvider{id: testProviderID, responses: responses}
	providers.RegisterProvider(mock)
	providers.RegisterModel(testModel, types.ModelInfo{
		ProviderID:      testProviderID,
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})
	return mock
}

func containsName(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

// mustJSON renders a value for byte comparison.
func mustJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// messageText concatenates the text and tool_result content of one message.
func messageText(t *testing.T, msg types.LlmMessage) string {
	t.Helper()
	blocks, ok := msg.Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("message content is %T", msg.Content)
	}
	var b strings.Builder
	for _, block := range blocks {
		b.WriteString(block.Text)
		b.WriteString(block.Content)
	}
	return b.String()
}

// assertPrefixStable fails unless every captured request carries the same
// tools and system prompt, and each request's messages extend the previous
// request's without altering any earlier one.
func assertPrefixStable(t *testing.T, provider *toolCapturingProvider) {
	t.Helper()
	first := provider.requestForCall(0)
	wantTools, wantSystem := mustJSON(t, first.Tools), first.System
	prev := first
	for i := 1; i < provider.callsMade(); i++ {
		req := provider.requestForCall(i)
		if got := mustJSON(t, req.Tools); got != wantTools {
			t.Fatalf("call %d: tool list changed\nwas %v\nnow %v", i, provider.toolsForCall(0), provider.toolsForCall(i))
		}
		if req.System != wantSystem {
			t.Fatalf("call %d: system prompt changed\nwas %q\nnow %q", i, wantSystem, req.System)
		}
		if len(req.Messages) < len(prev.Messages) {
			t.Fatalf("call %d: messages shrank from %d to %d", i, len(prev.Messages), len(req.Messages))
		}
		for j := range prev.Messages {
			if mustJSON(t, req.Messages[j]) != mustJSON(t, prev.Messages[j]) {
				t.Fatalf("call %d: earlier message %d changed", i, j)
			}
		}
		prev = req
	}
}

// TestPrefixStableAcrossMidRunPlanModeEnter is the red-on-revert test for the
// cache contract. Turn 1 calls EnterPlanMode; turn 2's request must carry the
// same tools and system prompt, and learn about plan mode from a notice
// appended to the messages.
func TestPrefixStableAcrossMidRunPlanModeEnter(t *testing.T) {
	planFile := t.TempDir() + "/plan.md"

	provider := setupToolCapturingProvider([][]types.LlmStreamEvent{
		toolUseResponse(tools.EnterPlanModeName, "tc-enter", map[string]any{}, 10, 5),
		// Auto-exit synthesis is disabled below so this turn ends the run.
		textResponse("planning now", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-prefix-enter")

	autoExitOff := false
	cfg := &RunConfig{
		Hooks: RunHooks{
			// Approve the model's plan-mode entry and hand back the plan
			// file path, as the session layer does in production.
			OnPlanModeEnter: func() (bool, string, string) {
				return true, "", planFile
			},
		},
	}
	b.StartRunWithConfig("req-prefix-enter", types.RunOptions{
		Prompt:           "review this",
		ProjectPath:      t.TempDir(),
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
		PlanModeAutoExit: &autoExitOff,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}
	if got := provider.callsMade(); got < 2 {
		t.Fatalf("expected at least 2 provider calls (turn 1 + turn 2), got %d", got)
	}

	assertPrefixStable(t, provider)

	// Both sentinels and the mutating tools are in the list in both modes.
	for _, name := range []string{tools.EnterPlanModeName, tools.ExitPlanModeName, "Bash", "Write", "Edit", "Read"} {
		if !containsName(provider.toolsForCall(0), name) {
			t.Errorf("tool list should offer %s in every mode, got %v", name, provider.toolsForCall(0))
		}
	}

	// The model learns the rules from the notice that follows the tool result.
	turn2 := provider.requestForCall(1)
	last := messageText(t, turn2.Messages[len(turn2.Messages)-1])
	if !strings.Contains(last, "[PLAN MODE]") || !strings.Contains(last, planFile) {
		t.Fatalf("turn 2 must end with the plan-mode enter notice, got %q", last)
	}
	if strings.Contains(turn2.System, "PLAN MODE") {
		t.Fatalf("plan-mode text must not be in the system prompt: %q", turn2.System)
	}
}

// TestPlanModeBashAllowlistReachesTheCall drives the per-prompt Bash allowance
// end to end. A slash command may declare extra Bash prefixes for one prompt;
// the run must allow exactly those in plan mode, refuse everything else, and
// not carry them into the next run.
func TestPlanModeBashAllowlistReachesTheCall(t *testing.T) {
	planFile := t.TempDir() + "/plan.md"
	autoExitOff := false
	start := func(reqID string, additions []string, commands ...string) *toolCapturingProvider {
		var script [][]types.LlmStreamEvent
		for i, cmd := range commands {
			script = append(script, toolUseResponse("Bash", fmt.Sprintf("tc-%d", i), map[string]any{"command": cmd}, 10, 5))
		}
		script = append(script, textResponse("done", 10, 5))
		provider := setupToolCapturingProvider(script)
		b := NewApiBackend()
		c := collectEvents(b, reqID)
		b.StartRunWithConfig(reqID, types.RunOptions{
			Prompt:                              "file the issue",
			ProjectPath:                         t.TempDir(),
			Model:                               testModel,
			EarlyStopEnabled:                    testEarlyStopDisabled(),
			PlanMode:                            true,
			PlanFilePath:                        planFile,
			PlanModeAutoExit:                    &autoExitOff,
			BashAllowlistAdditionsForThisPrompt: additions,
		}, &RunConfig{})
		if !waitForExit(c, 5*time.Second) {
			t.Fatal("timed out waiting for run to exit")
		}
		return provider
	}
	// resultAfter returns the text of the tool-result message that follows
	// tool call n: the message right after that call's assistant turn.
	resultAfter := func(provider *toolCapturingProvider, n int) string {
		before := len(provider.requestForCall(n).Messages)
		return messageText(t, provider.requestForCall(n + 1).Messages[before+1])
	}

	// SAFETY: `echo` stands in for a real side-effecting command.
	withAddition := start("req-bash-addition", []string{"echo issue create"}, "echo issue create --title x", "git diff")
	if got := resultAfter(withAddition, 0); strings.HasPrefix(got, "Plan mode:") {
		t.Errorf("a command matching the per-prompt allowance was refused: %s", got)
	}
	if got := resultAfter(withAddition, 1); !strings.Contains(got, "not in the allowed list") {
		t.Errorf("a command outside the allowance must be refused, got: %s", got)
	}
	if !containsName(withAddition.toolsForCall(0), "Bash") {
		t.Errorf("Bash must be in the plan-mode tool list, got %v", withAddition.toolsForCall(0))
	}

	next := start("req-bash-next", nil, "echo issue create --title x")
	if got := resultAfter(next, 0); !strings.HasPrefix(got, "Plan mode: Bash is not available") {
		t.Errorf("the allowance leaked into a later run; want Bash refused, got: %s", got)
	}
}

// TestToolListStableWithinARun pins that a run with no mode change hands the
// provider the same list on every turn.
func TestToolListStableWithinARun(t *testing.T) {
	provider := setupToolCapturingProvider([][]types.LlmStreamEvent{
		// Turn 1: a normal tool call, no plan-mode transition.
		toolUseResponse("Read", "tc-read", map[string]any{"file_path": "/nonexistent"}, 10, 5),
		// Turn 2: end_turn.
		textResponse("done", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-stable")

	b.StartRunWithConfig("req-stable", types.RunOptions{
		Prompt:           "read something",
		ProjectPath:      t.TempDir(),
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, &RunConfig{})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}

	if got := provider.callsMade(); got < 2 {
		t.Fatalf("expected at least 2 provider calls, got %d", got)
	}

	turn1 := provider.toolsForCall(0)
	turn2 := provider.toolsForCall(1)
	if len(turn1) != len(turn2) {
		t.Fatalf("tool list changed across turns with no plan-mode flip: turn1=%v turn2=%v", turn1, turn2)
	}
	for i := range turn1 {
		if turn1[i] != turn2[i] {
			t.Fatalf("tool list changed across turns with no plan-mode flip: turn1=%v turn2=%v", turn1, turn2)
		}
	}
}
