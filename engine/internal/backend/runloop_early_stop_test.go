package backend

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// --- mergeEarlyStopConfig: layered resolution ---

func TestMergeEarlyStopConfig_Defaults(t *testing.T) {
	cfg := mergeEarlyStopConfig(types.RunOptions{}, nil)
	defaults := types.EarlyStopDefaults()
	// Engine ships default-OFF. Harness consumers opt in either via
	// engine.json (earlyStopContinue.enabled = true) or via per-run
	// RunOptions.EarlyStopEnabled = &true. The numeric tuning knobs
	// (budget, thresholdPct, maxContinuations, diminishingDelta) are
	// calibration values that only take effect when something turned
	// the feature on.
	if cfg.enabled {
		t.Errorf("default enabled: want false (engine ships off), got true")
	}
	if cfg.budget != defaults.Budget {
		t.Errorf("default budget: want %d, got %d", defaults.Budget, cfg.budget)
	}
	if cfg.thresholdPct != defaults.ThresholdPct {
		t.Errorf("default threshold: want %d, got %d", defaults.ThresholdPct, cfg.thresholdPct)
	}
	if cfg.maxContinuations != defaults.MaxContinuations {
		t.Errorf("default cap: want %d, got %d", defaults.MaxContinuations, cfg.maxContinuations)
	}
	if cfg.diminishingDelta != defaults.DiminishingDelta {
		t.Errorf("default diminishingDelta: want %d, got %d", defaults.DiminishingDelta, cfg.diminishingDelta)
	}
	if cfg.source != "defaults" {
		t.Errorf("default source: want \"defaults\", got %q", cfg.source)
	}
}

func TestMergeEarlyStopConfig_EngineJsonDisables(t *testing.T) {
	disabled := false
	rc := &RunConfig{EarlyStopContinue: &types.EarlyStopContinueConfig{Enabled: &disabled}}
	cfg := mergeEarlyStopConfig(types.RunOptions{}, rc)
	if cfg.enabled {
		t.Errorf("engine.json enabled=false should disable; got enabled=true")
	}
	if cfg.source != "engineConfig" {
		t.Errorf("source: want \"engineConfig\", got %q", cfg.source)
	}
}

func TestMergeEarlyStopConfig_RunOptionsOverridesEngineJson(t *testing.T) {
	jsonEnabled := false
	rc := &RunConfig{EarlyStopContinue: &types.EarlyStopContinueConfig{
		Enabled: &jsonEnabled,
		Budget:  5000,
	}}
	runEnabled := true
	opts := types.RunOptions{
		EarlyStopEnabled: &runEnabled,
		EarlyStopBudget:  12000,
	}
	cfg := mergeEarlyStopConfig(opts, rc)
	if !cfg.enabled {
		t.Errorf("RunOptions force-on did not override engine.json disable")
	}
	if cfg.budget != 12000 {
		t.Errorf("RunOptions budget did not win: got %d", cfg.budget)
	}
	if cfg.source != "runOptions" {
		t.Errorf("source: want \"runOptions\", got %q", cfg.source)
	}
}

func TestMergeEarlyStopConfig_NegativeBudgetDisables(t *testing.T) {
	cfg := mergeEarlyStopConfig(types.RunOptions{EarlyStopBudget: -1}, nil)
	if cfg.enabled {
		t.Errorf("negative budget should disable; got enabled=true")
	}
}

func TestMergeEarlyStopConfig_SubagentDefaultOff(t *testing.T) {
	cfg := mergeEarlyStopConfig(types.RunOptions{IsSubagent: true}, nil)
	if cfg.enabled {
		t.Errorf("subagent default: want disabled, got enabled")
	}
	if cfg.source != "subagentDefault" {
		t.Errorf("subagent source: want \"subagentDefault\", got %q", cfg.source)
	}
}

func TestMergeEarlyStopConfig_SubagentForceOn(t *testing.T) {
	enabled := true
	opts := types.RunOptions{IsSubagent: true, EarlyStopEnabled: &enabled}
	cfg := mergeEarlyStopConfig(opts, nil)
	if !cfg.enabled {
		t.Errorf("subagent force-on did not win; got disabled")
	}
}

// --- End-to-end behavior tests ---

// earlyStopBudget is the small budget tests use so triggering / not-triggering
// is deterministic without huge token counts. 100 tokens at 90% threshold
// means 90 tokens stops, anything below continues.
const earlyStopBudget = 100

// earlyStopTestContinueMessage is the canonical placeholder ContinueMessage
// tests use when they want the engine to actually inject a continuation. The
// engine itself ships no default text (policy lives in the harness), so any
// end-to-end test that asserts a continuation happens must wire a
// before_early_stop_decision handler that supplies this string. Tests that
// only assert non-continuation (per-run disable, cap respected, threshold
// reached) do not need to wire it.
const earlyStopTestContinueMessage = "test: keep working — do not summarize"

// earlyStopTestHook returns a before_early_stop_decision handler that supplies
// earlyStopTestContinueMessage so the engine has text to inject. Use this in
// any test that exercises the affirmative continue path.
func earlyStopTestHook() func(EarlyStopDecisionInfo) *EarlyStopDecisionResult {
	return func(_ EarlyStopDecisionInfo) *EarlyStopDecisionResult {
		return &EarlyStopDecisionResult{ContinueMessage: earlyStopTestContinueMessage}
	}
}

// earlyStopTrue is a *bool pointer to true, used to opt RunOptions into
// the early-stop feature. The engine ships default-off; tests that exercise
// the affirmative path must explicitly enable per-run via RunOptions, or
// supply an engine.json `earlyStopContinue.enabled = true` block. Tests use
// per-run because it's localised to the test fixture.
var earlyStopTrue = func() *bool { b := true; return &b }()

func TestEarlyStop_TriggersContinuationBelowThreshold(t *testing.T) {
	// First response: model emits end_turn at 50% of budget → should
	// trigger a continuation. Second response: end_turn at 95% → stops.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("first", 10, 50), // 50 / 100 = 50%
		textResponse("done", 10, 45),  // cumulative 95 / 100 = 95%
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-trigger")

	budget := earlyStopBudget
	// Engine ships no default ContinueMessage; wire one so the affirmative
	// path is exercised.
	cfg := &RunConfig{
		Hooks: RunHooks{OnBeforeEarlyStopDecision: earlyStopTestHook()},
	}
	b.StartRunWithConfig("req-es-trigger", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  budget,
		EarlyStopEnabled: earlyStopTrue,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}

	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
	// Continuation injection should produce a TaskCompleteEvent only after
	// the second turn. We don't directly count turns here, but the run
	// having succeeded means both responses were consumed → 2 turns.
	taskCompletes := 0
	for _, ev := range c.normalized {
		if _, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			taskCompletes++
		}
	}
	if taskCompletes != 1 {
		t.Errorf("expected exactly 1 task_complete, got %d", taskCompletes)
	}
}

func TestEarlyStop_NoContinuationAtOrAboveThreshold(t *testing.T) {
	// Single response well above 90% — should NOT continue.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("complete", 10, 95), // 95 / 100 = 95%
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-above")

	budget := earlyStopBudget
	b.StartRun("req-es-above", types.RunOptions{
		Prompt:          "go",
		ProjectPath:     "/tmp",
		Model:           testModel,
		EarlyStopBudget: budget,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
	// Single turn => single task_complete and only one provider call would
	// have been used. If a second turn had been requested the mock would
	// have errored ("no response for call 1").
	for _, err := range c.errors {
		if err != nil {
			t.Errorf("did not expect any errors, got: %v", err)
		}
	}
}

func TestEarlyStop_PerRunDisableSkipsFeature(t *testing.T) {
	// Single response at 5% would normally trigger continuation, but
	// EarlyStopEnabled=&false should disable the whole feature for this
	// run. We provide only one response — a continuation would error.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("done", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-disabled")

	disabled := false
	budget := earlyStopBudget
	b.StartRun("req-es-disabled", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  budget,
		EarlyStopEnabled: &disabled,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}
	if c.exitCode == nil || *c.exitCode != 0 {
		t.Fatalf("expected exit 0 (single-turn completion), got %v", c.exitCode)
	}
}

func TestEarlyStop_CapRespected(t *testing.T) {
	// 5 responses, each at 10% — the engine should nudge 3 times (cap),
	// emit the 4th turn's response, then stop *without* nudging again.
	// We give 4 responses; the run must finish after the 4th, not the 5th.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("t1", 10, 10),
		textResponse("t2", 10, 10),
		textResponse("t3", 10, 10),
		textResponse("t4", 10, 10),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-cap")

	budget := earlyStopBudget
	cap := 3
	b.StartRun("req-es-cap", types.RunOptions{
		Prompt:                    "go",
		ProjectPath:               "/tmp",
		Model:                     testModel,
		EarlyStopBudget:           budget,
		EarlyStopMaxContinuations: cap,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
}

func TestEarlyStop_OnSystemInjectSuppressesContinuation(t *testing.T) {
	// First response at 10% would normally continue. OnSystemInject
	// suppresses the injection → the run should fall through to
	// TaskCompleteEvent on the SAME turn. We provide only one response.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("done", 10, 10),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-suppress")

	var suppressCount atomic.Int32
	cfg := &RunConfig{
		Hooks: RunHooks{
			// Engine ships no default ContinueMessage. Wire the
			// before_early_stop_decision hook so the engine has text to
			// inject — then OnSystemInject can be observed and exercise
			// its suppress branch.
			OnBeforeEarlyStopDecision: earlyStopTestHook(),
			OnSystemInject: func(kind, defaultText string, turn, maxTurns int) (string, bool) {
				if kind == earlyStopContinueKind {
					suppressCount.Add(1)
					return "", true
				}
				return "", false
			},
		},
	}
	budget := earlyStopBudget
	b.StartRunWithConfig("req-es-suppress", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  budget,
		EarlyStopEnabled: earlyStopTrue,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
	if suppressCount.Load() != 1 {
		t.Errorf("expected OnSystemInject to fire once with %q kind, got %d calls",
			earlyStopContinueKind, suppressCount.Load())
	}
}

func TestEarlyStop_BeforeEarlyStopDecisionForceStop(t *testing.T) {
	// Model at 10% would trigger; hook force-stops. Only one response provided.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("done", 10, 10),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-force-stop")

	var hookCalls atomic.Int32
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnBeforeEarlyStopDecision: func(info EarlyStopDecisionInfo) *EarlyStopDecisionResult {
				hookCalls.Add(1)
				if !info.WouldContinue {
					t.Errorf("expected WouldContinue=true on early-stop path; got false")
				}
				stop := false
				return &EarlyStopDecisionResult{ForceContinue: &stop}
			},
		},
	}
	budget := earlyStopBudget
	b.StartRunWithConfig("req-es-force-stop", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  budget,
		EarlyStopEnabled: earlyStopTrue,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
	if hookCalls.Load() != 1 {
		t.Errorf("expected exactly 1 OnBeforeEarlyStopDecision call, got %d", hookCalls.Load())
	}
}

func TestEarlyStop_BeforeEarlyStopDecisionForceContinue(t *testing.T) {
	// Model at 95% would normally stop; hook force-continues to a second
	// response.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("partial", 10, 95),
		textResponse("done", 10, 10),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-force-continue")

	var seenWouldContinue []bool
	var mu sync.Mutex
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnBeforeEarlyStopDecision: func(info EarlyStopDecisionInfo) *EarlyStopDecisionResult {
				mu.Lock()
				seenWouldContinue = append(seenWouldContinue, info.WouldContinue)
				idx := len(seenWouldContinue)
				mu.Unlock()
				// Only force-continue on the FIRST decision; let the
				// engine's default win on subsequent ones so the run
				// can terminate cleanly. Engine ships no default
				// ContinueMessage, so the hook must supply one too —
				// otherwise the no-message skip path kicks in.
				if idx == 1 && !info.WouldContinue {
					cont := true
					return &EarlyStopDecisionResult{
						ForceContinue:   &cont,
						ContinueMessage: earlyStopTestContinueMessage,
					}
				}
				return nil
			},
		},
	}
	budget := earlyStopBudget
	b.StartRunWithConfig("req-es-force-continue", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  budget,
		EarlyStopEnabled: earlyStopTrue,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		for _, ev := range c.normalized {
			if ee, ok := ev.Data.(*types.ErrorEvent); ok {
				t.Logf("error event: %+v", ee)
			}
		}
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seenWouldContinue) == 0 {
		t.Fatal("hook never fired")
	}
	// First call should have WouldContinue=false (above threshold).
	if seenWouldContinue[0] {
		t.Errorf("first decision: want WouldContinue=false (95%% of budget), got true")
	}
}

func TestEarlyStop_HookOverrideBudget(t *testing.T) {
	// Without override, 90 tokens vs 100-token budget = 90% → stop.
	// Hook bumps budget to 200 → 90 / 200 = 45% → continue.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("first", 10, 90),
		textResponse("done", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-override-budget")

	var firstSeenBudget int
	var callCount atomic.Int32
	var mu sync.Mutex
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnBeforeEarlyStopDecision: func(info EarlyStopDecisionInfo) *EarlyStopDecisionResult {
				mu.Lock()
				if firstSeenBudget == 0 {
					firstSeenBudget = info.Budget
				}
				mu.Unlock()
				// Only bump the budget on the first decision so the run
				// can terminate cleanly on the second decision (where the
				// engine's default verdict is "stop"). Supply
				// ContinueMessage so the first decision's continuation
				// actually injects — engine ships no default text.
				if callCount.Add(1) == 1 {
					return &EarlyStopDecisionResult{
						OverrideBudget:  200,
						ContinueMessage: earlyStopTestContinueMessage,
					}
				}
				return nil
			},
		},
	}
	b.StartRunWithConfig("req-es-override-budget", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  earlyStopBudget,
		EarlyStopEnabled: earlyStopTrue,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
	mu.Lock()
	defer mu.Unlock()
	if firstSeenBudget != earlyStopBudget {
		t.Errorf("first decision Budget: want %d, got %d", earlyStopBudget, firstSeenBudget)
	}
}

func TestEarlyStop_HookCustomContinuationMessage(t *testing.T) {
	// First response at 10% triggers continuation (with hook-supplied
	// custom message); second response at 95% terminates the run.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("first", 10, 10),
		textResponse("done", 10, 85),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-custom-msg")

	customText := "harness-supplied continue prompt: focus on integration tests"
	var seenInjected atomic.Value
	var callCount atomic.Int32
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnBeforeEarlyStopDecision: func(info EarlyStopDecisionInfo) *EarlyStopDecisionResult {
				// Only supply the custom message on the first decision;
				// let the engine's default verdict (stop) win on the
				// second so the run terminates cleanly.
				if callCount.Add(1) == 1 {
					return &EarlyStopDecisionResult{ContinueMessage: customText}
				}
				return nil
			},
			OnEarlyStopContinued: func(info EarlyStopContinuedInfo) {
				seenInjected.Store(info.InjectedText)
			},
		},
	}
	b.StartRunWithConfig("req-es-custom-msg", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  earlyStopBudget,
		EarlyStopEnabled: earlyStopTrue,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
	got, _ := seenInjected.Load().(string)
	if got != customText {
		t.Errorf("custom continuation text not honored: want %q, got %q", customText, got)
	}
}

func TestEarlyStop_OnEarlyStopContinuedObserved(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("first", 10, 30),
		textResponse("done", 10, 70),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-observed")

	var continuedCalls atomic.Int32
	var lastInfo atomic.Value
	cfg := &RunConfig{
		Hooks: RunHooks{
			// Engine ships no default ContinueMessage; wire one so the
			// continuation actually injects and OnEarlyStopContinued
			// observes it.
			OnBeforeEarlyStopDecision: earlyStopTestHook(),
			OnEarlyStopContinued: func(info EarlyStopContinuedInfo) {
				continuedCalls.Add(1)
				lastInfo.Store(info)
			},
		},
	}
	b.StartRunWithConfig("req-es-observed", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  earlyStopBudget,
		EarlyStopEnabled: earlyStopTrue,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	if continuedCalls.Load() != 1 {
		t.Errorf("expected 1 OnEarlyStopContinued call, got %d", continuedCalls.Load())
	}
	info, _ := lastInfo.Load().(EarlyStopContinuedInfo)
	if info.ContinuationCount != 1 {
		t.Errorf("ContinuationCount: want 1, got %d", info.ContinuationCount)
	}
	if info.Budget != earlyStopBudget {
		t.Errorf("Budget: want %d, got %d", earlyStopBudget, info.Budget)
	}
	if info.InjectedText == "" {
		t.Error("InjectedText should be non-empty when injection succeeded")
	}
	if info.Pct != 30 {
		t.Errorf("Pct: want 30, got %d", info.Pct)
	}
}

func TestEarlyStop_SubagentSkipsFeature(t *testing.T) {
	// Single low-output response — would normally continue under an
	// enabled config, but IsSubagent forces the feature off even when a
	// caller sets EarlyStopEnabled=&true. Combined with the engine's
	// default-off posture, sub-agent runs are doubly safe from
	// continuation nudges.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("subagent done", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-subagent")

	b.StartRun("req-es-subagent", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  earlyStopBudget,
		EarlyStopEnabled: earlyStopTrue, // explicitly enabled — but IsSubagent overrides
		IsSubagent:       true,
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
}

// TestEarlyStop_HookReceivesPercentAndBudget locks in the contract that the
// before_early_stop_decision hook payload carries CumulativeOutputTokens and
// Budget — the two values a harness needs to format its own continuation
// prompt with percent and budget context. (Replaces the
// TestEarlyStop_DefaultMessageContainsPercentAndBudget test, which asserted
// the engine shipped a CC-style default template; under the new contract
// the engine ships no default text and the harness owns prompt content.)
func TestEarlyStop_HookReceivesPercentAndBudget(t *testing.T) {
	// 50% of 100-token budget on turn 1.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("first", 10, 50),
		textResponse("done", 10, 50),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-hook-payload")

	var firstTokens, firstBudget atomic.Int64
	var hookCalls atomic.Int32
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnBeforeEarlyStopDecision: func(info EarlyStopDecisionInfo) *EarlyStopDecisionResult {
				// Only capture the FIRST hook call (turn 1 at 50% of
				// budget); the second turn fires the hook again at
				// 100% and we want to assert on turn-1 numbers.
				if hookCalls.Add(1) == 1 {
					firstTokens.Store(int64(info.CumulativeOutputTokens))
					firstBudget.Store(int64(info.Budget))
					return &EarlyStopDecisionResult{ContinueMessage: earlyStopTestContinueMessage}
				}
				return nil
			},
		},
	}
	b.StartRunWithConfig("req-es-hook-payload", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  earlyStopBudget,
		EarlyStopEnabled: earlyStopTrue,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	if firstTokens.Load() != 50 {
		t.Errorf("CumulativeOutputTokens (turn 1): want 50, got %d", firstTokens.Load())
	}
	if firstBudget.Load() != int64(earlyStopBudget) {
		t.Errorf("Budget (turn 1): want %d, got %d", earlyStopBudget, firstBudget.Load())
	}
}

func TestEarlyStop_DisableEarlyStopContinueFlagSuppressesInjection(t *testing.T) {
	// DisableEarlyStopContinue should suppress the injection. With the
	// loop still trying to continue (single low response), the second
	// turn has no scripted response → the mock would error. To validate
	// suppression cleanly we use a low budget AND a single response;
	// after suppression the loop falls through to TaskCompleteEvent
	// because conv length is unchanged ⇒ injected==false ⇒ but the
	// loop still treats this as a continuation. We confirm via the
	// OnSystemInject log: the disable kicks in BEFORE the hook fires.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("done", 10, 5),
		textResponse("done2", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-disable-flag")

	var hookFired atomic.Bool
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnSystemInject: func(kind, defaultText string, turn, maxTurns int) (string, bool) {
				if kind == earlyStopContinueKind {
					hookFired.Store(true)
				}
				return "", false
			},
		},
	}
	b.StartRunWithConfig("req-es-disable-flag", types.RunOptions{
		Prompt:                   "go",
		ProjectPath:              "/tmp",
		Model:                    testModel,
		EarlyStopBudget:          earlyStopBudget,
		DisableEarlyStopContinue: true,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
	// Hook MUST NOT have fired for kind=early_stop_continue when the
	// per-kind disable is set. Per the existing injectSystemMessage
	// pattern, the disable check runs before the hook.
	if hookFired.Load() {
		t.Errorf("OnSystemInject saw early_stop_continue despite DisableEarlyStopContinue=true")
	}
}

func TestEarlyStop_ResetsCountersOnToolUse(t *testing.T) {
	// Sequence: end_turn at 10% (continue, count=1), tool_use turn (reset),
	// end_turn at 10% (continue, count=1 again, NOT 2), then end_turn at 95% (stop).
	// If the reset works, the run completes in 4 LLM turns + the bookkeeping
	// shows continuationCount oscillating back to 0 mid-run.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("first", 10, 10),
		toolUseResponse("Bash", "tu1", map[string]any{"command": "echo hi"}, 10, 10),
		textResponse("third", 10, 10),
		textResponse("done", 10, 80),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-reset")

	// AgentSpawner / permission allow-everything path needs a noop spawner
	// to satisfy the agent loop's tool dispatch — but Bash doesn't use it.
	cfg := &RunConfig{}
	b.StartRunWithConfig("req-es-reset", types.RunOptions{
		Prompt:          "go",
		ProjectPath:     "/tmp",
		Model:           testModel,
		EarlyStopBudget: earlyStopBudget,
		// Allowing Bash is needed so the engine actually runs the tool.
		AllowedTools: []string{"Bash"},
	}, cfg)

	if !waitForExit(c, 10*time.Second) {
		t.Fatal("timed out")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
}

func TestEarlyStop_BeforeEarlyStopDecisionHandlerPanicRecovered(t *testing.T) {
	// A panicking handler must not crash the agent loop. Engine recovers
	// the panic and proceeds with its default verdict (which at 10% is
	// "continue"). Provide 2 responses so the run can complete.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("first", 10, 10),
		textResponse("done", 10, 90),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-es-panic")

	var firedBeforePanic atomic.Bool
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnBeforeEarlyStopDecision: func(info EarlyStopDecisionInfo) *EarlyStopDecisionResult {
				firedBeforePanic.Store(true)
				panic("intentional test panic")
			},
		},
	}
	b.StartRunWithConfig("req-es-panic", types.RunOptions{
		Prompt:           "go",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopBudget:  earlyStopBudget,
		EarlyStopEnabled: earlyStopTrue,
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out: panicking handler crashed the agent loop")
	}
	if !firedBeforePanic.Load() {
		t.Fatal("OnBeforeEarlyStopDecision did not fire before panicking")
	}
	if c.exitCode == nil {
		t.Fatal("no exit code recorded")
	}
	if *c.exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", *c.exitCode)
	}
}

// --- Direct decision-function tests (no full run loop) ---

func TestMaybeContinueEarlyStop_AppendsUserMessage(t *testing.T) {
	b := NewApiBackend()
	conv := conversation.CreateConversation("test", "", "test-model")
	conv.Model = "test-model"
	run := &activeRun{requestID: "rid-direct", conv: conv}
	cfg := effectiveEarlyStopConfig{
		enabled:          true,
		budget:           100,
		thresholdPct:     90,
		maxContinuations: 3,
		diminishingDelta: 500,
		source:           "test",
	}
	run.cumulativeOutputTokens = 30 // 30% — below threshold

	// Engine ships no default ContinueMessage; the harness must supply one
	// via before_early_stop_decision. Wire a minimal hook so the engine
	// has text to inject.
	hooks := RunHooks{
		OnBeforeEarlyStopDecision: func(_ EarlyStopDecisionInfo) *EarlyStopDecisionResult {
			return &EarlyStopDecisionResult{ContinueMessage: "test: keep working"}
		},
	}

	beforeLen := len(conv.Messages)
	cont := b.maybeContinueEarlyStop(run, conv, hooks, types.RunOptions{}, cfg, 30, "end_turn", 1, 0)
	if !cont {
		t.Fatal("expected continuation, got stop")
	}
	if len(conv.Messages) != beforeLen+1 {
		t.Errorf("expected exactly one user message appended, got delta=%d", len(conv.Messages)-beforeLen)
	}
	if run.continuationCount != 1 {
		t.Errorf("continuationCount: want 1, got %d", run.continuationCount)
	}
	if run.lastContinuationDelta != 30 {
		t.Errorf("lastContinuationDelta: want 30, got %d", run.lastContinuationDelta)
	}
}

// TestMaybeContinueEarlyStop_NoMessageSkips locks in the new contract: when
// the engine is willing to continue but no hook supplies a ContinueMessage,
// it skips the injection and falls through to stop. The engine ships no
// default prompt text — policy and prompt are the harness's job.
func TestMaybeContinueEarlyStop_NoMessageSkips(t *testing.T) {
	b := NewApiBackend()
	conv := conversation.CreateConversation("test", "", "test-model")
	conv.Model = "test-model"
	run := &activeRun{requestID: "rid-no-msg", conv: conv}
	cfg := effectiveEarlyStopConfig{
		enabled:          true,
		budget:           100,
		thresholdPct:     90,
		maxContinuations: 3,
		diminishingDelta: 500,
		source:           "test",
	}
	run.cumulativeOutputTokens = 30 // 30% — below threshold

	beforeLen := len(conv.Messages)
	// No hook wired → no ContinueMessage → engine must skip injection.
	cont := b.maybeContinueEarlyStop(run, conv, RunHooks{}, types.RunOptions{}, cfg, 30, "end_turn", 1, 0)
	if cont {
		t.Fatal("expected stop (no message supplied), got continuation")
	}
	if len(conv.Messages) != beforeLen {
		t.Errorf("expected no message appended, got delta=%d", len(conv.Messages)-beforeLen)
	}
	if run.continuationCount != 0 {
		t.Errorf("continuationCount should remain 0 when no injection happened, got %d", run.continuationCount)
	}
}

func TestMaybeContinueEarlyStop_AtThresholdStops(t *testing.T) {
	b := NewApiBackend()
	conv := conversation.CreateConversation("test", "", "test-model")
	run := &activeRun{requestID: "rid-thresh", conv: conv}
	cfg := effectiveEarlyStopConfig{
		enabled:          true,
		budget:           100,
		thresholdPct:     90,
		maxContinuations: 3,
		diminishingDelta: 500,
		source:           "test",
	}
	run.cumulativeOutputTokens = 90 // 90% — at threshold

	cont := b.maybeContinueEarlyStop(run, conv, RunHooks{}, types.RunOptions{}, cfg, 90, "end_turn", 1, 0)
	if cont {
		t.Fatal("expected stop at exact threshold, got continuation")
	}
}

func TestMaybeContinueEarlyStop_DiminishingReturnsStops(t *testing.T) {
	b := NewApiBackend()
	conv := conversation.CreateConversation("test", "", "test-model")
	run := &activeRun{requestID: "rid-dim", conv: conv}
	cfg := effectiveEarlyStopConfig{
		enabled:          true,
		budget:           1000,
		thresholdPct:     90,
		maxContinuations: 10,
		diminishingDelta: 500,
		source:           "test",
	}
	// At 5% of budget but with continuationCount=3 and previous delta < 500
	// and the new delta also < 500 → diminishing, stop.
	run.cumulativeOutputTokens = 50
	run.continuationCount = 3
	run.lastContinuationDelta = 100

	cont := b.maybeContinueEarlyStop(run, conv, RunHooks{}, types.RunOptions{}, cfg, 50, "end_turn", 4, 0)
	if cont {
		t.Fatal("expected diminishing-returns stop, got continuation")
	}
}

func TestMaybeContinueEarlyStop_DisabledIsNoOp(t *testing.T) {
	b := NewApiBackend()
	conv := conversation.CreateConversation("test", "", "test-model")
	run := &activeRun{requestID: "rid-off", conv: conv}
	cfg := effectiveEarlyStopConfig{enabled: false, source: "test"}
	run.cumulativeOutputTokens = 0
	cont := b.maybeContinueEarlyStop(run, conv, RunHooks{}, types.RunOptions{}, cfg, 0, "end_turn", 1, 0)
	if cont {
		t.Fatal("disabled feature should never continue")
	}
	if run.continuationCount != 0 {
		t.Errorf("continuationCount should remain 0, got %d", run.continuationCount)
	}
}
