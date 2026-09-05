package extension

import (
	"testing"
)

// TestFireBeforeEarlyStopDecision_NoHandlersReturnsNil exercises the
// "no opinion" path: when no host has a handler registered, the SDK must
// return nil so the engine uses its default verdict. Regression guard
// against accidentally returning a zero-valued struct that the engine
// would mistake for "harness wants to force-stop".
func TestFireBeforeEarlyStopDecision_NoHandlersReturnsNil(t *testing.T) {
	sdk := NewSDK()
	got := sdk.FireBeforeEarlyStopDecision(testCtx(), EarlyStopDecisionInfo{
		RunID:                  "rid",
		Model:                  "test-model",
		TurnNumber:             3,
		StopReason:             "end_turn",
		CumulativeOutputTokens: 100,
		Budget:                 1000,
		ThresholdPct:           90,
		WouldContinue:          true,
	})
	if got != nil {
		t.Fatalf("no-handler case must return nil; got %+v", got)
	}
}

// TestFireBeforeEarlyStopDecision_PayloadFields verifies the handler
// receives a fully populated payload (every documented field). Defends
// against a future change to EarlyStopDecisionInfo that silently drops
// a field at the dispatch boundary.
func TestFireBeforeEarlyStopDecision_PayloadFields(t *testing.T) {
	sdk := NewSDK()

	var received EarlyStopDecisionInfo
	sdk.On(HookBeforeEarlyStopDecision, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(EarlyStopDecisionInfo)
		return nil, nil
	})

	info := EarlyStopDecisionInfo{
		RunID:                  "rid-1",
		Model:                  "claude-sonnet-4-6",
		TurnNumber:             5,
		StopReason:             "end_turn",
		CumulativeOutputTokens: 4500,
		Budget:                 8000,
		ThresholdPct:           90,
		ContinuationCount:      2,
		MaxContinuations:       3,
		LastContinuationDelta:  1200,
		WouldContinue:          true,
		Eligible:               true,
		IsSubagent:             false,
	}
	_ = sdk.FireBeforeEarlyStopDecision(testCtx(), info)

	if received != info {
		t.Errorf("payload roundtrip mismatch\nwant %+v\ngot  %+v", info, received)
	}
}

// TestFireBeforeEarlyStopDecision_LastNonNilWinsPerField verifies the
// per-field merge semantics documented on the hook: when multiple handlers
// return results, later writers win for the specific fields they set,
// leaving earlier non-nil values for other fields intact. Mirrors the
// FireBeforePrompt resolution pattern.
func TestFireBeforeEarlyStopDecision_LastNonNilWinsPerField(t *testing.T) {
	sdk := NewSDK()

	first := true
	sdk.On(HookBeforeEarlyStopDecision, func(ctx *Context, payload interface{}) (interface{}, error) {
		// Handler 1: supplies a custom message AND sets ForceContinue=true.
		return &EarlyStopDecisionResult{
			ForceContinue:   &first,
			ContinueMessage: "from handler 1",
		}, nil
	})
	sdk.On(HookBeforeEarlyStopDecision, func(ctx *Context, payload interface{}) (interface{}, error) {
		// Handler 2: overrides ContinueMessage and bumps the budget.
		// Does NOT touch ForceContinue, so handler 1's value survives.
		return &EarlyStopDecisionResult{
			OverrideBudget:  16000,
			ContinueMessage: "from handler 2",
		}, nil
	})

	got := sdk.FireBeforeEarlyStopDecision(testCtx(), EarlyStopDecisionInfo{})
	if got == nil {
		t.Fatal("expected non-nil result when at least one handler set a field")
	}
	if got.ForceContinue == nil || *got.ForceContinue != true {
		t.Errorf("ForceContinue: want &true (from handler 1, unchanged by handler 2); got %v", got.ForceContinue)
	}
	if got.OverrideBudget != 16000 {
		t.Errorf("OverrideBudget: want 16000 (from handler 2); got %d", got.OverrideBudget)
	}
	if got.ContinueMessage != "from handler 2" {
		t.Errorf("ContinueMessage: want \"from handler 2\" (later writer); got %q", got.ContinueMessage)
	}
}

// TestFireBeforeEarlyStopDecision_MapResultIsAccepted exercises the
// JSON-RPC subprocess extension path, where handlers return a decoded
// map[string]interface{} rather than a typed struct. The SDK must decode
// the same fields with the same semantics.
func TestFireBeforeEarlyStopDecision_MapResultIsAccepted(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookBeforeEarlyStopDecision, func(ctx *Context, payload interface{}) (interface{}, error) {
		return map[string]interface{}{
			"forceContinue":        true,
			"overrideBudget":       float64(12000), // JSON numeric path
			"overrideThresholdPct": float64(85),
			"continueMessage":      "from json-rpc",
		}, nil
	})
	got := sdk.FireBeforeEarlyStopDecision(testCtx(), EarlyStopDecisionInfo{})
	if got == nil {
		t.Fatal("expected non-nil result")
	}
	if got.ForceContinue == nil || !*got.ForceContinue {
		t.Errorf("ForceContinue: want &true; got %v", got.ForceContinue)
	}
	if got.OverrideBudget != 12000 {
		t.Errorf("OverrideBudget: want 12000; got %d", got.OverrideBudget)
	}
	if got.OverrideThresholdPct != 85 {
		t.Errorf("OverrideThresholdPct: want 85; got %d", got.OverrideThresholdPct)
	}
	if got.ContinueMessage != "from json-rpc" {
		t.Errorf("ContinueMessage: want \"from json-rpc\"; got %q", got.ContinueMessage)
	}
}

// TestFireEarlyStopContinued_ObserveOnlyDeliversPayload verifies the
// observe-only hook delivers its payload intact. Handler return values
// are ignored.
func TestFireEarlyStopContinued_ObserveOnlyDeliversPayload(t *testing.T) {
	sdk := NewSDK()

	var received EarlyStopContinuedInfo
	called := false
	sdk.On(HookEarlyStopContinued, func(ctx *Context, payload interface{}) (interface{}, error) {
		called = true
		received = payload.(EarlyStopContinuedInfo)
		return "ignored return value", nil
	})

	info := EarlyStopContinuedInfo{
		RunID:                  "rid-2",
		TurnNumber:             4,
		ContinuationCount:      1,
		Pct:                    42,
		CumulativeOutputTokens: 3400,
		Budget:                 8000,
		InjectedText:           "Keep working — do not summarize.",
	}
	if err := sdk.FireEarlyStopContinued(testCtx(), info); err != nil {
		t.Fatalf("FireEarlyStopContinued returned err: %v", err)
	}
	if !called {
		t.Fatal("handler never fired")
	}
	if received != info {
		t.Errorf("payload mismatch\nwant %+v\ngot  %+v", info, received)
	}
}
