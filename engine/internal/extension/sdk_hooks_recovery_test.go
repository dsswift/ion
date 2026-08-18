package extension

import (
	"testing"
)

func TestFireBeforeRunRecovery_NoHandlersReturnsNil(t *testing.T) {
	sdk := NewSDK()
	got := sdk.FireBeforeRunRecovery(testCtx(), BeforeRunRecoveryInfo{
		RecoveryID:     "rec-1",
		ConversationID: "conv-1",
		Attempt:        1,
		MaxAttempts:    3,
	})
	if got != nil {
		t.Fatalf("no-handler case must return nil; got %+v", got)
	}
}

func TestFireBeforeRunRecovery_PayloadRoundtrip(t *testing.T) {
	sdk := NewSDK()

	var received BeforeRunRecoveryInfo
	sdk.On(HookBeforeRunRecovery, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(BeforeRunRecoveryInfo)
		return nil, nil
	})

	info := BeforeRunRecoveryInfo{
		RecoveryID:     "rec-42",
		ConversationID: "conv-abc",
		Attempt:        2,
		MaxAttempts:    5,
		Prompt:         "fix the tests",
		Model:          "claude-sonnet-4-6",
		SessionKey:     "sk-main",
	}
	_ = sdk.FireBeforeRunRecovery(testCtx(), info)

	if received != info {
		t.Errorf("payload roundtrip mismatch\nwant %+v\ngot  %+v", info, received)
	}
}

func TestFireBeforeRunRecovery_ActionSkip(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookBeforeRunRecovery, func(ctx *Context, payload interface{}) (interface{}, error) {
		return &BeforeRunRecoveryResult{Action: "skip"}, nil
	})

	got := sdk.FireBeforeRunRecovery(testCtx(), BeforeRunRecoveryInfo{
		RecoveryID:     "rec-1",
		ConversationID: "conv-1",
		Attempt:        1,
		MaxAttempts:    3,
	})
	if got == nil {
		t.Fatal("expected non-nil result")
	}
	if got.Action != "skip" {
		t.Errorf("Action: want skip; got %q", got.Action)
	}
}

func TestFireBeforeRunRecovery_LastNonNilWinsPerField(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBeforeRunRecovery, func(ctx *Context, payload interface{}) (interface{}, error) {
		return &BeforeRunRecoveryResult{
			Action:      "recover",
			Instruction: "from handler 1",
		}, nil
	})
	sdk.On(HookBeforeRunRecovery, func(ctx *Context, payload interface{}) (interface{}, error) {
		return &BeforeRunRecoveryResult{
			Action: "skip",
		}, nil
	})

	got := sdk.FireBeforeRunRecovery(testCtx(), BeforeRunRecoveryInfo{})
	if got == nil {
		t.Fatal("expected non-nil result")
	}
	if got.Action != "skip" {
		t.Errorf("Action: want skip (handler 2 wins); got %q", got.Action)
	}
	if got.Instruction != "from handler 1" {
		t.Errorf("Instruction: want from handler 1 (handler 2 did not set); got %q", got.Instruction)
	}
}

func TestFireBeforeRunRecovery_MapResult(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBeforeRunRecovery, func(ctx *Context, payload interface{}) (interface{}, error) {
		return map[string]interface{}{
			"action":      "skip",
			"instruction": "via map",
		}, nil
	})

	got := sdk.FireBeforeRunRecovery(testCtx(), BeforeRunRecoveryInfo{
		RecoveryID:     "rec-1",
		ConversationID: "conv-1",
		Attempt:        1,
		MaxAttempts:    3,
	})
	if got == nil {
		t.Fatal("expected non-nil result from map handler")
	}
	if got.Action != "skip" {
		t.Errorf("Action: want skip; got %q", got.Action)
	}
	if got.Instruction != "via map" {
		t.Errorf("Instruction: want via map; got %q", got.Instruction)
	}
}

func TestFireBeforeRunRecovery_AllHandlersAbstain(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBeforeRunRecovery, func(ctx *Context, payload interface{}) (interface{}, error) {
		return &BeforeRunRecoveryResult{}, nil
	})

	got := sdk.FireBeforeRunRecovery(testCtx(), BeforeRunRecoveryInfo{})
	if got != nil {
		t.Fatalf("zero-value result must resolve to nil; got %+v", got)
	}
}
