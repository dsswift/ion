package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func boolPtr(v bool) *bool { return &v }

func TestMergeRunRecovery_NilPreserved(t *testing.T) {
	result := MergeConfigs(nil, DefaultConfig(), &types.EngineRuntimeConfig{})
	if result.RunRecovery != nil {
		t.Fatal("RunRecovery should remain nil when no layer sets it")
	}
}

func TestMergeRunRecovery_FieldByFieldMerge(t *testing.T) {
	base := &types.EngineRuntimeConfig{RunRecovery: &types.RunRecoveryConfig{
		Enabled: boolPtr(true), MaxAttempts: 4,
	}}
	overlay := &types.EngineRuntimeConfig{RunRecovery: &types.RunRecoveryConfig{MaxAttempts: 2}}

	result := MergeConfigs(nil, base, overlay)
	if result.RunRecovery == nil || result.RunRecovery.Enabled == nil || !*result.RunRecovery.Enabled {
		t.Fatal("base enabled value was not preserved")
	}
	if result.RunRecovery.MaxAttempts != 2 {
		t.Fatalf("MaxAttempts = %d, want overlay value 2", result.RunRecovery.MaxAttempts)
	}
}

func TestMergeRunRecovery_OverlayDisables(t *testing.T) {
	base := &types.EngineRuntimeConfig{RunRecovery: &types.RunRecoveryConfig{Enabled: boolPtr(true)}}
	overlay := &types.EngineRuntimeConfig{RunRecovery: &types.RunRecoveryConfig{Enabled: boolPtr(false)}}

	result := MergeConfigs(nil, base, overlay)
	if result.RunRecovery == nil || result.RunRecovery.Enabled == nil || *result.RunRecovery.Enabled {
		t.Fatal("explicit overlay disable should win")
	}
}

func TestMergeRunRecovery_DoesNotMutateBase(t *testing.T) {
	base := &types.EngineRuntimeConfig{RunRecovery: &types.RunRecoveryConfig{Enabled: boolPtr(true), MaxAttempts: 4}}
	overlay := &types.EngineRuntimeConfig{RunRecovery: &types.RunRecoveryConfig{MaxAttempts: 2}}
	_ = MergeConfigs(nil, base, overlay)
	if base.RunRecovery.MaxAttempts != 4 {
		t.Fatal("merge mutated base configuration")
	}
}

func TestRunRecoveryDefaultMaxAttempts(t *testing.T) {
	if types.RunRecoveryDefaultMaxAttempts != 2 {
		t.Fatalf("default max attempts = %d, want 2", types.RunRecoveryDefaultMaxAttempts)
	}
}
