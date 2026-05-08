package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestMergeLimitsSystemMessageFields(t *testing.T) {
	boolTrue := true
	boolFalse := false

	base := &types.EngineRuntimeConfig{
		DefaultModel: "test-model",
		Limits: types.LimitsConfig{
			SuppressSystemMessages:  &boolFalse,
			DisablePlanModeReminder: &boolFalse,
		},
	}

	override := &types.EngineRuntimeConfig{
		Limits: types.LimitsConfig{
			SuppressSystemMessages:  &boolTrue,
			DisableTurnLimitWarning: &boolTrue,
		},
	}

	result := MergeConfigs(nil, base, override)

	// SuppressSystemMessages should be overridden to true
	if result.Limits.SuppressSystemMessages == nil || !*result.Limits.SuppressSystemMessages {
		t.Error("SuppressSystemMessages should be true after merge")
	}

	// DisablePlanModeReminder should be preserved from base (false)
	if result.Limits.DisablePlanModeReminder == nil || *result.Limits.DisablePlanModeReminder {
		t.Error("DisablePlanModeReminder should be false (preserved from base)")
	}

	// DisableTurnLimitWarning should be set from override
	if result.Limits.DisableTurnLimitWarning == nil || !*result.Limits.DisableTurnLimitWarning {
		t.Error("DisableTurnLimitWarning should be true from override")
	}

	// DisableMaxTokenContinue should be nil (not set in either)
	if result.Limits.DisableMaxTokenContinue != nil {
		t.Error("DisableMaxTokenContinue should be nil (not set)")
	}
}

func TestMergeNilDoesNotOverride(t *testing.T) {
	boolTrue := true

	base := &types.EngineRuntimeConfig{
		DefaultModel: "test-model",
		Limits: types.LimitsConfig{
			DisableMaxTokenContinue: &boolTrue,
		},
	}

	// Override has nil for all system message fields
	override := &types.EngineRuntimeConfig{
		DefaultModel: "override-model",
	}

	result := MergeConfigs(nil, base, override)

	// DisableMaxTokenContinue should be preserved from base
	if result.Limits.DisableMaxTokenContinue == nil || !*result.Limits.DisableMaxTokenContinue {
		t.Error("DisableMaxTokenContinue should be preserved as true from base")
	}
}
