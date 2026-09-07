package backend

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/cost"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestOnCallCost_DeliversExactTurnCost pins child 06's core deliverable: the
// RunConfig.OnCallCost callback must deliver the EXACT same *telemetry.CallCost
// values the run loop's own cost.TurnCost-derived arithmetic produces for that
// turn -- no independent recomputation, no drift. This exercises the real
// ApiBackend run loop (runloop.go, the turnUsage != nil block) end to end,
// not a synthetic call to the mapping code in isolation.
func TestOnCallCost_DeliversExactTurnCost(t *testing.T) {
	// testModel pricing (see TestCostTracking): costPer1kInput=0.003,
	// costPer1kOutput=0.015. 500 input + 200 output tokens, no cache.
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("call cost test", 500, 200),
	})

	var (
		gotModel string
		gotCost  *telemetry.CallCost
		calls    int
	)
	cfg := &RunConfig{
		OnCallCost: func(model string, cost *telemetry.CallCost) {
			calls++
			gotModel = model
			gotCost = cost
		},
	}

	b := NewApiBackend()
	c := collectEvents(b, "req-call-cost")
	b.StartRunWithConfig("req-call-cost", types.RunOptions{
		Prompt:           "call cost",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, cfg)

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	if calls != 1 {
		t.Fatalf("expected OnCallCost to fire exactly once, got %d", calls)
	}
	if gotModel != testModel {
		t.Errorf("expected model %q, got %q", testModel, gotModel)
	}
	if gotCost == nil {
		t.Fatal("expected non-nil CallCost")
	}

	wantUsage := types.LlmUsage{InputTokens: 500, OutputTokens: 200}
	wantCostUsd := cost.TurnCost(testModel, wantUsage)

	if gotCost.InputTokens != 500 {
		t.Errorf("InputTokens = %d, want 500", gotCost.InputTokens)
	}
	if gotCost.OutputTokens != 200 {
		t.Errorf("OutputTokens = %d, want 200", gotCost.OutputTokens)
	}
	if gotCost.CacheReadInputTokens != 0 {
		t.Errorf("CacheReadInputTokens = %d, want 0", gotCost.CacheReadInputTokens)
	}
	if gotCost.CacheCreationInputTokens != 0 {
		t.Errorf("CacheCreationInputTokens = %d, want 0", gotCost.CacheCreationInputTokens)
	}
	if gotCost.CostUsd != wantCostUsd {
		t.Errorf("CostUsd = %v, want %v (cost.TurnCost result)", gotCost.CostUsd, wantCostUsd)
	}
	if wantCostUsd <= 0 {
		t.Fatal("test setup produced a zero expected cost -- assertion above is vacuous")
	}

	// Also confirm the delivered cost matches the run's own totalCost/
	// TaskCompleteEvent.CostUsd bookkeeping -- the two must never diverge
	// since both derive from the identical computeCost call.
	for _, ev := range c.normalized {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			if tc.CostUsd != gotCost.CostUsd {
				t.Errorf("TaskCompleteEvent.CostUsd = %v, OnCallCost delivered %v -- drift", tc.CostUsd, gotCost.CostUsd)
			}
			return
		}
	}
	t.Error("did not find task_complete event")
}

// TestOnCallCost_NilIsNoop confirms a nil OnCallCost (the default, until a
// sibling child wires session-layer consumption) is a safe no-op: the run
// completes normally with no panic and no behavior change versus StartRun.
func TestOnCallCost_NilIsNoop(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("no callback", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-call-cost-nil")
	b.StartRunWithConfig("req-call-cost-nil", types.RunOptions{
		Prompt:           "no callback",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, &RunConfig{}) // OnCallCost left nil

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}
}

// TestCodexCallCost_TokenBucketsWithZeroCostUsd pins section 3 of the spec:
// codex reports real token usage via NotifTokenUsageUpdated, but billing is
// subscription-metered, so CostUsd must be a real, present zero -- never an
// omitted/nil cost object, which would falsely claim "no data available".
func TestCodexCallCost_TokenBucketsWithZeroCostUsd(t *testing.T) {
	breakdown := codexrpc.TokenUsageBreakdown{
		InputTokens:       120,
		OutputTokens:      45,
		CachedInputTokens: 30,
	}

	got := codexCallCost(breakdown)
	if got == nil {
		t.Fatal("expected non-nil *CallCost -- codex usage IS known, only cost is a known zero")
	}
	if got.InputTokens != 120 || got.OutputTokens != 45 || got.CacheReadInputTokens != 30 {
		t.Errorf("token buckets not carried through: %+v", got)
	}
	if got.CostUsd != 0 {
		t.Errorf("CostUsd = %v, want 0 (subscription-metered)", got.CostUsd)
	}
}

// TestCodexCallCost_MatchesTokenUsageUpdatedNotification exercises the real
// codex notification-translation path (translateCodexNotification), not just
// the isolated mapping helper, confirming codexCallCost's inputs line up with
// what a real thread/tokenUsage/updated notification carries.
func TestCodexCallCost_MatchesTokenUsageUpdatedNotification(t *testing.T) {
	notif := codexrpc.TokenUsageNotification{ThreadID: "t1", TurnID: "turn1"}
	notif.TokenUsage.Last = codexrpc.TokenUsageBreakdown{InputTokens: 200, OutputTokens: 80, CachedInputTokens: 10}
	raw, err := json.Marshal(notif)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	run := &codexRun{requestID: "req-codex-usage", threadID: "t1"}
	events, exit := translateCodexNotification(run, codexrpc.NotifTokenUsageUpdated, raw)
	if exit != nil {
		t.Fatal("token usage notification must not end the run")
	}
	if len(events) != 1 {
		t.Fatalf("expected exactly 1 UsageEvent, got %d", len(events))
	}
	ue, ok := events[0].Data.(*types.UsageEvent)
	if !ok {
		t.Fatalf("expected *types.UsageEvent, got %T", events[0].Data)
	}
	if ue.Usage.InputTokens == nil || *ue.Usage.InputTokens != 200 {
		t.Errorf("UsageEvent input tokens mismatch: %+v", ue.Usage)
	}

	got := codexCallCost(notif.TokenUsage.Last)
	if got.InputTokens != *ue.Usage.InputTokens {
		t.Errorf("codexCallCost.InputTokens = %d, does not match the UsageEvent the same notification produced (%d)", got.InputTokens, *ue.Usage.InputTokens)
	}
	if got.CostUsd != 0 {
		t.Errorf("CostUsd = %v, want 0", got.CostUsd)
	}
}

// TestImageGenerationCallCost_MatchesImageCost pins that the image-generation
// *telemetry.CallCost is derived from, and never diverges from, cost.ImageCost's
// own return value, with zeroed token buckets (image billing is per-image).
func TestImageGenerationCallCost_MatchesImageCost(t *testing.T) {
	const model = "test-child06-image-cost-model"
	providers.RegisterModel(model, types.ModelInfo{
		ProviderID:   "test",
		ModelKind:    "image",
		CostPerImage: 0.03,
	})
	t.Cleanup(func() { providers.UnregisterModel(model) })

	for _, images := range []int{0, 1, 3} {
		want := cost.ImageCost(model, images)
		got := imageGenerationCallCost(model, images)
		if got == nil {
			t.Fatalf("images=%d: expected non-nil *CallCost", images)
		}
		if got.CostUsd != want {
			t.Errorf("images=%d: CostUsd = %v, want %v (cost.ImageCost)", images, got.CostUsd, want)
		}
		if got.InputTokens != 0 || got.OutputTokens != 0 || got.CacheReadInputTokens != 0 || got.CacheCreationInputTokens != 0 {
			t.Errorf("images=%d: expected zeroed token buckets, got %+v", images, got)
		}
	}
	if cost.ImageCost(model, 1) <= 0 {
		t.Fatal("test setup produced a zero expected cost -- assertion above is vacuous")
	}
}

// TestClaudeCodeAssistantMessage_CarriesNoCostField pins section 2's finding
// structurally: types.TaskUpdateEvent (Claude Code's assistant-completion
// signal) carries a types.AssistantMessagePayload with a per-message
// UsageData (token counts -- InputTokens/OutputTokens/CacheReadInputTokens/
// CacheCreationInputTokens are present), but UsageData has no dollar-cost
// field anywhere in its JSON shape. So even the "partial data available"
// case the spec calls out (cache-token data present) genuinely cannot
// produce a *telemetry.CallCost -- there is no CostUsd to read, not merely
// one this child chooses not to read. The correct value a caller (the
// session-layer wiring, out of scope for this child) passes to
// ConversationEmitter.AssistantMessage for Claude Code is an explicit nil,
// with no backend-side helper needed since there is nothing to map.
//
// If a future TaskUpdateEvent/AssistantMessagePayload/UsageData change adds
// a cost-bearing field, this test's field enumeration changes and the
// "cost=nil is correct for Claude Code" claim above must be re-examined --
// that is the point of pinning the struct shape rather than only prose.
func TestClaudeCodeAssistantMessage_CarriesNoCostField(t *testing.T) {
	msgFields := structFieldNames(reflect.TypeOf(types.AssistantMessagePayload{}))
	if !contains(msgFields, "Usage") {
		t.Fatalf("expected AssistantMessagePayload.Usage to exist (token data IS available); fields=%v", msgFields)
	}

	usageFields := structFieldNames(reflect.TypeOf(types.UsageData{}))
	for _, f := range usageFields {
		if strings.Contains(strings.ToLower(f), "cost") {
			t.Errorf("UsageData gained a cost-bearing field %q -- Claude Code's cost=nil rationale (no dollar figure anywhere on TaskUpdateEvent) no longer holds and must be re-verified", f)
		}
	}

	completeFields := structFieldNames(reflect.TypeOf(types.TaskCompleteEvent{}))
	if !contains(completeFields, "CostUsd") {
		t.Fatal("expected TaskCompleteEvent.CostUsd to exist -- Claude Code's ONLY cost signal is the run-delta total on TaskCompleteEvent, never per-message")
	}
}

func structFieldNames(t reflect.Type) []string {
	names := make([]string, 0, t.NumField())
	for i := 0; i < t.NumField(); i++ {
		names = append(names, t.Field(i).Name)
	}
	return names
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
