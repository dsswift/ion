package backend

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// Regression coverage for the mid-run plan-mode tool-list rebuild.
//
// runLoop builds the provider tool list ONCE before the turn loop, because
// buildToolDefs reassembles MCP and external tool definitions and paying that
// per turn would be waste. But plan mode can flip mid-run: the model calls the
// EnterPlanMode sentinel and interceptEnterPlanMode sets run.planMode = true
// (runloop_plan_mode_gates.go). Before the fix these tests pin, the provider
// kept receiving the auto-mode list for the remainder of the run — with
// EnterPlanMode still present and ExitPlanMode absent — so the plan-mode prompt
// instructed the model to finish via a tool it had not been given.
//
// The tests below drive a real run through StartRunWithConfig and capture the
// Tools slice handed to the provider on EVERY turn, then assert on the turn
// that follows the EnterPlanMode call. Asserting the post-flip turn (rather
// than inspecting buildToolDefs directly) is what makes this a regression test:
// it fails on the unfixed runloop and passes on the fixed one.

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

// TestToolDefsRebuiltAfterMidRunPlanModeEnter is the red-on-revert test for the
// stale tool list. Turn 1 calls EnterPlanMode; turn 2's provider call must
// carry the PLAN-MODE tool set.
//
// Without the rebuild the turn-2 list is byte-identical to turn 1's: it still
// advertises EnterPlanMode and the mutating tools, and omits ExitPlanMode.
func TestToolDefsRebuiltAfterMidRunPlanModeEnter(t *testing.T) {
	planFile := t.TempDir() + "/plan.md"

	provider := setupToolCapturingProvider([][]types.LlmStreamEvent{
		// Turn 1: the model requests plan mode.
		toolUseResponse(tools.EnterPlanModeName, "tc-enter", map[string]any{}, 10, 5),
		// Turn 2: plain text end_turn. Auto-exit synthesis is disabled below
		// so this turn terminates the run without extra machinery.
		textResponse("planning now", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-rebuild")

	autoExitOff := false
	cfg := &RunConfig{
		Hooks: RunHooks{
			// Approve the model's plan-mode entry and hand back the plan
			// file path, exactly as the session layer's
			// RequestPlanModeEnter does in production.
			OnPlanModeEnter: func() (bool, string, string) {
				return true, "", planFile
			},
		},
	}
	b.StartRunWithConfig("req-rebuild", types.RunOptions{
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

	// Turn 1 ran in auto mode: EnterPlanMode offered, ExitPlanMode not.
	turn1 := provider.toolsForCall(0)
	if !containsName(turn1, tools.EnterPlanModeName) {
		t.Errorf("turn 1 tools should offer %s, got %v", tools.EnterPlanModeName, turn1)
	}
	if containsName(turn1, tools.ExitPlanModeName) {
		t.Errorf("turn 1 tools should NOT offer %s (auto mode), got %v", tools.ExitPlanModeName, turn1)
	}

	// Turn 2 is the assertion this test exists for. After the mid-run flip the
	// provider must see the plan-mode set.
	turn2 := provider.toolsForCall(1)
	if !containsName(turn2, tools.ExitPlanModeName) {
		t.Errorf("turn 2 tools must offer %s after mid-run plan-mode entry, got %v",
			tools.ExitPlanModeName, turn2)
	}
	if containsName(turn2, tools.EnterPlanModeName) {
		t.Errorf("turn 2 tools must NOT still offer %s once in plan mode, got %v",
			tools.EnterPlanModeName, turn2)
	}
	// Bash is filtered out of the plan-mode list when no allowlist is
	// configured. Its presence on turn 2 is the same staleness defect seen
	// from the write side.
	if containsName(turn2, "Bash") {
		t.Errorf("turn 2 tools must NOT offer Bash in plan mode, got %v", turn2)
	}
	// Write and Edit ARE expected in plan mode: buildToolDefs allows them
	// unconditionally so the model can author the plan file, and
	// applyPlanModeWriteGate restricts the target to the canonical plan path
	// at call time (runloop_plan_mode_gates.go). Asserting their presence
	// pins that this turn-2 list is the real plan-mode list.
	for _, expected := range []string{"Write", "Edit"} {
		if !containsName(turn2, expected) {
			t.Errorf("turn 2 tools should offer %s in plan mode (plan-file authoring), got %v",
				expected, turn2)
		}
	}
	// Read survives the filter — a positive control proving the turn-2 list is
	// a real plan-mode list and not simply empty.
	if !containsName(turn2, "Read") {
		t.Errorf("turn 2 tools should still offer Read in plan mode, got %v", turn2)
	}
}

// TestToolDefsNotRebuiltWhenPlanModeStable pins the other side of the
// conditional: a run whose plan-mode state never changes must reuse the list
// built before the loop. This is what keeps the fix from degrading into an
// unconditional per-turn rebuild.
func TestToolDefsNotRebuiltWhenPlanModeStable(t *testing.T) {
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
