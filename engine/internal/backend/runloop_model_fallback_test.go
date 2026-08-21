package backend

import (
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestModelFallback_SwapsToDefaultAndEmitsEvent locks in the fix for the
// "child agent dispatched with unresolved tier alias" bug. When a child run
// starts with a model string that doesn't resolve to a registered provider
// (the canonical case: extension specialists declaring `model: standard`
// when the user has no `tiers.standard` configured), the engine must:
//
//  1. Fall back to RunConfig.DefaultModel (already wired pre-fix).
//  2. Emit exactly one ModelFallbackEvent so consumers can react (NEW).
//  3. Leave the LLM's text output byte-identical (NEW — pins the
//     "engine never mutates stream content" invariant against any future
//     change that tries to "helpfully" append a fallback note to
//     TaskCompleteEvent.Result).
//
// Without (2) and (3), the engine either failed silently (no signal to
// consumers that the model wasn't what they asked for) or risked
// poisoning downstream parsers by mutating stream content. See the
// grand-surfing-moth plan and CLAUDE.md § "The typed-event corollary".
func TestModelFallback_SwapsToDefaultAndEmitsEvent(t *testing.T) {
	const llmOutput = "this is the exact verbatim LLM output, do not touch"

	// Register a provider only for testModel — the "real" model. The run
	// will be started with "standard" (unregistered) and must fall back.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse(llmOutput, 10, 5),
	})

	b := NewApiBackend()

	cfg := &RunConfig{
		DefaultModel: testModel,
	}

	c := collectEvents(b, "req-fallback-1")
	b.StartRunWithConfig("req-fallback-1", types.RunOptions{
		Prompt:           "hello",
		ProjectPath:      "/tmp",
		Model:            "standard", // unresolvable; must fall back
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Guarantee 1: no invalid_model error — the fallback actually fired.
	for _, ev := range c.normalized {
		if errEv, ok := ev.Data.(*types.ErrorEvent); ok && errEv.ErrorCode == "invalid_model" {
			t.Fatalf("unexpected invalid_model ErrorEvent — fallback didn't fire: %s", errEv.ErrorMessage)
		}
	}

	// Guarantee 2: exactly one ModelFallbackEvent with the right fields.
	var fallbacks []*types.ModelFallbackEvent
	for _, ev := range c.normalized {
		if mf, ok := ev.Data.(*types.ModelFallbackEvent); ok {
			fallbacks = append(fallbacks, mf)
		}
	}
	if len(fallbacks) != 1 {
		t.Fatalf("expected exactly 1 ModelFallbackEvent, got %d", len(fallbacks))
	}
	mf := fallbacks[0]
	if mf.RequestedModel != "standard" {
		t.Errorf("RequestedModel: got %q want %q", mf.RequestedModel, "standard")
	}
	if mf.FallbackModel != testModel {
		t.Errorf("FallbackModel: got %q want %q", mf.FallbackModel, testModel)
	}
	if mf.Reason != "no_provider_found" {
		t.Errorf("Reason: got %q want %q", mf.Reason, "no_provider_found")
	}

	// Guarantee 3: the LLM's output is byte-identical in TaskCompleteEvent.
	// Exact string equality — no substring match — pins the rule that the
	// engine never mutates stream content to communicate the fallback.
	// If a future change adds a notice to Result, this test fails loudly.
	var tcResult string
	var tcSeen bool
	for _, ev := range c.normalized {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			tcResult = tc.Result
			tcSeen = true
		}
	}
	if !tcSeen {
		t.Fatal("no TaskCompleteEvent emitted")
	}
	if tcResult != llmOutput {
		t.Errorf("TaskCompleteEvent.Result was mutated by the engine.\n  got:  %q\n  want: %q (verbatim LLM output)", tcResult, llmOutput)
	}
}

func TestModelFallback_UpdatesSlashServingModelProvenance(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("fallback response", 10, 5),
	})
	b := NewApiBackend()
	c := collectEvents(b, "req-slash-fallback")
	opts := types.RunOptions{
		Prompt:                      "/check-running",
		ProjectPath:                 "/tmp",
		Model:                       "slash-unavailable-model",
		ResolvedSlashModelAlias:     "fast",
		ResolvedSlashModelEffective: "slash-unavailable-model",
		EarlyStopEnabled:            testEarlyStopDisabled(),
		MaxTurns:                    1,
	}
	b.StartRunWithConfig("req-slash-fallback", opts, &RunConfig{DefaultModel: testModel})
	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for slash fallback exit")
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	var persisted *types.UserTurnPersistedEvent
	for _, ev := range c.normalized {
		if candidate, ok := ev.Data.(*types.UserTurnPersistedEvent); ok {
			persisted = candidate
			break
		}
	}
	if persisted == nil {
		t.Fatal("missing UserTurnPersistedEvent")
	}
	if persisted.SlashModelAlias != "" {
		t.Errorf("SlashModelAlias = %q, want empty after provider fallback", persisted.SlashModelAlias)
	}
	if persisted.SlashModelEffective != testModel {
		t.Errorf("SlashModelEffective = %q, want serving fallback %q", persisted.SlashModelEffective, testModel)
	}
}

// TestModelFallback_SkippedWhenNoDefaultConfigured locks in the chosen
// behaviour for the "no fallback available" case: when the run's RunConfig
// has DefaultModel == "" (or the run has no RunConfig at all), the
// existing no_provider_found / invalid_model hard fail still wins and NO
// ModelFallbackEvent is emitted. Emitting an event with empty FallbackModel
// would mislead clients about which model is running.
//
// This pins the "short-circuit, no fake event" decision documented in the
// grand-surfing-moth plan §2 "Default-also-missing case".
func TestModelFallback_SkippedWhenNoDefaultConfigured(t *testing.T) {
	// Register a provider so the runtime is wired, but the test run uses
	// an unrelated model. With DefaultModel == "" the fallback guard
	// short-circuits.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("unused", 10, 5),
	})

	b := NewApiBackend()

	cfg := &RunConfig{
		DefaultModel: "", // No default — fallback must not fire.
	}

	c := collectEvents(b, "req-fallback-skipped-1")
	b.StartRunWithConfig("req-fallback-skipped-1", types.RunOptions{
		Prompt:           "hello",
		ProjectPath:      "/tmp",
		Model:            "standard",
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for run to exit")
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Guarantee 1: no ModelFallbackEvent was emitted.
	for _, ev := range c.normalized {
		if _, ok := ev.Data.(*types.ModelFallbackEvent); ok {
			t.Fatal("ModelFallbackEvent emitted with no DefaultModel — must not fire when no fallback is available")
		}
	}

	// Guarantee 2: the existing invalid_model error still fires with its
	// actionable message text.
	var invalidModel *types.ErrorEvent
	for _, ev := range c.normalized {
		if errEv, ok := ev.Data.(*types.ErrorEvent); ok && errEv.ErrorCode == "invalid_model" {
			invalidModel = errEv
			break
		}
	}
	if invalidModel == nil {
		t.Fatal("expected ErrorEvent{ErrorCode: invalid_model} when fallback is unavailable")
	}
	if !strings.Contains(invalidModel.ErrorMessage, "standard") {
		t.Errorf("invalid_model message should name the requested model, got: %q", invalidModel.ErrorMessage)
	}

	// Guarantee 3: the run exited with a non-zero code (hard fail).
	if c.exitCode == nil {
		t.Fatal("expected non-nil exit code")
	}
	if *c.exitCode == 0 {
		t.Errorf("expected non-zero exit code on hard-fail path, got 0")
	}
}
