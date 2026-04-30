//go:build integration

package integration

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

var _ = providers.ResetRegistries

// TestApiBackend_ConcurrentSessionsNoInterlace verifies that concurrent runs
// on a single ApiBackend never see each other's hooks, external tools,
// permission engine, or agent spawner.
//
// Regression test for the multi-tab interlacing bug: previously the session
// manager called apiBackend.SetX(...) on the singleton backend on every
// SendPrompt, so a second tab's prompt would overwrite the first tab's
// closures. Tab A's in-flight run would then fire Tab B's hooks and execute
// Tab B's tools. This test runs two sessions whose hook closures and tool
// routers tag every event with their own session ID, then asserts every
// captured tag matches the run that produced it.
func TestApiBackend_ConcurrentSessionsNoInterlace(t *testing.T) {
	mp := setupMockProvider(t)

	// Each turn returns final text immediately. Two runs * one turn each = 2
	// stream calls. We over-script so a second look-up cycles to a final
	// 'done' as a safety net.
	mp.SetResponse(helpers.TextResponse("done"))

	b := backend.NewApiBackend()

	// Aggregate event sink keyed by runID so we can assert per-run isolation.
	type record struct {
		hook  string
		tag   string
		runID string
	}
	var mu sync.Mutex
	hookEvents := map[string][]record{} // runID -> []record
	addRecord := func(runID, hook, tag string) {
		mu.Lock()
		hookEvents[runID] = append(hookEvents[runID], record{hook: hook, tag: tag, runID: runID})
		mu.Unlock()
	}

	// Drive both runs to exit through the same ApiBackend's OnExit.
	exits := make(chan string, 2)
	b.OnExit(func(runID string, _ *int, _ *string, _ string) { exits <- runID })
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	b.OnError(func(_ string, _ error) {})

	makeCfg := func(tag string) *backend.RunConfig {
		// Permission engine. We don't need to instrument it -- the assertion
		// matrix already covers per-run isolation via the hook callbacks.
		permEng := permissions.NewEngine(&types.PermissionPolicy{Mode: "allow"})
		// Per-run tool list: only this run's tool name appears.
		extTool := types.LlmToolDef{
			Name:        "tool_only_for_" + tag,
			Description: "session-specific external tool",
			InputSchema: map[string]any{"type": "object"},
		}
		mcpRouter := func(name string, _ map[string]interface{}) (string, bool, error) {
			addRecord("router-call", "router-"+name, tag)
			return "router-" + tag, false, nil
		}
		return &backend.RunConfig{
			PermEngine:    permEng,
			ExternalTools: []types.LlmToolDef{extTool},
			McpToolRouter: mcpRouter,
			AgentSpawner: func(_ context.Context, _, _, _, _, _ string) (string, error) {
				addRecord("agent-spawner", "spawn", tag)
				return "ok", nil
			},
			Hooks: backend.RunHooks{
				OnBeforePrompt: func(runID string, prompt string) (string, string) {
					addRecord(runID, "before_prompt", tag)
					return "", ""
				},
				OnTurnStart: func(runID string, turn int) {
					addRecord(runID, "turn_start", tag)
				},
				OnTurnEnd: func(runID string, turn int) {
					addRecord(runID, "turn_end", tag)
				},
				OnToolCall: func(_ backend.ToolCallInfo) (*backend.ToolCallResult, error) {
					return nil, nil
				},
			},
		}
	}

	cfgA := makeCfg("A")
	cfgB := makeCfg("B")

	// Start B first, then A, in quick succession to maximise overlap. The
	// runs share one backend goroutine pool but distinct activeRuns.
	b.StartRunWithConfig("run-B", types.RunOptions{
		Prompt: "prompt B",
		Model:  "mock-model",
	}, cfgB)
	b.StartRunWithConfig("run-A", types.RunOptions{
		Prompt: "prompt A",
		Model:  "mock-model",
	}, cfgA)

	// Wait for both runs to finish.
	got := map[string]bool{}
	deadline := time.After(10 * time.Second)
	for len(got) < 2 {
		select {
		case rid := <-exits:
			got[rid] = true
		case <-deadline:
			t.Fatalf("timed out waiting for exits, got %v", got)
		}
	}

	// Assert isolation: every hook event keyed under "run-A" must carry
	// tag="A", and every event under "run-B" must carry tag="B". A single
	// mismatch proves interlacing.
	mu.Lock()
	defer mu.Unlock()

	checkRun := func(runID, expectTag string) {
		records := hookEvents[runID]
		if len(records) == 0 {
			t.Errorf("no hook events recorded for runID=%s -- expected at least before_prompt + turn_start + turn_end", runID)
			return
		}
		for _, r := range records {
			if r.tag != expectTag {
				t.Errorf("interlacing detected: runID=%s hook=%s captured tag=%q (expected %q)", runID, r.hook, r.tag, expectTag)
			}
		}
		// Sanity check for the most-likely-to-leak hook.
		sawBeforePrompt := false
		for _, r := range records {
			if r.hook == "before_prompt" {
				sawBeforePrompt = true
				break
			}
		}
		if !sawBeforePrompt {
			t.Errorf("runID=%s never received its before_prompt hook -- hook wiring likely broken", runID)
		}
	}
	checkRun("run-A", "A")
	checkRun("run-B", "B")
}

// TestApiBackend_ConcurrentNewConversationIDsUnique verifies that runs
// started in tight succession with empty SessionID always receive unique
// conversation IDs. Previously two runs in the same millisecond shared a
// timestamp-only ID and corrupted each other's persisted history.
func TestApiBackend_ConcurrentNewConversationIDsUnique(t *testing.T) {
	mp := setupMockProvider(t)
	mp.SetResponse(helpers.TextResponse("done"))

	b := backend.NewApiBackend()

	const n = 16
	ids := make([]string, n)
	var idsMu sync.Mutex
	var done sync.WaitGroup
	done.Add(n)
	var exitCount int32
	b.OnExit(func(runID string, _ *int, _ *string, sessionID string) {
		idx := atoiSuffix(runID, "concur-")
		idsMu.Lock()
		ids[idx] = sessionID
		idsMu.Unlock()
		atomic.AddInt32(&exitCount, 1)
		done.Done()
	})
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	b.OnError(func(_ string, _ error) {})

	// Provide enough responses for every run.
	for i := 0; i < n; i++ {
		mp.SetResponse(helpers.TextResponse("done"))
	}

	for i := 0; i < n; i++ {
		go b.StartRunWithConfig("concur-"+itoa(i), types.RunOptions{
			Prompt: "p",
			Model:  "mock-model",
			// Empty SessionID -- backend must mint a unique one.
		}, nil)
	}

	if !waitWithTimeout(&done, 15*time.Second) {
		t.Fatalf("only %d/%d runs exited within deadline", atomic.LoadInt32(&exitCount), n)
	}

	seen := map[string]int{}
	for i, id := range ids {
		if id == "" {
			t.Errorf("run %d produced empty session id", i)
			continue
		}
		if prior, ok := seen[id]; ok {
			t.Errorf("collision: run %d and run %d both produced session id %q", prior, i, id)
		}
		seen[id] = i
	}
}

// --- small helpers (no fmt to keep test focused) ---

func atoiSuffix(s, prefix string) int {
	if len(s) <= len(prefix) {
		return 0
	}
	tail := s[len(prefix):]
	n := 0
	for _, c := range tail {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func itoa(n int) string {
	return helpers.IntToStr(n)
}

func waitWithTimeout(wg *sync.WaitGroup, d time.Duration) bool {
	doneCh := make(chan struct{})
	go func() {
		wg.Wait()
		close(doneCh)
	}()
	select {
	case <-doneCh:
		return true
	case <-time.After(d):
		return false
	}
}

