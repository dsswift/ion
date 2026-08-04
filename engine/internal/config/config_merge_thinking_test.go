package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// config_merge_thinking_test.go — pins the layered merge of the engine-wide
// extended-thinking default (`engine.json` → `thinking`).
//
// The field is the WEAKEST layer of a three-layer precedence chain:
//
//	engine.json default ← EngineConfig.Thinking (session) ← thinkingEffort (prompt)
//
// The merge itself only has to compose the JSON layers (user global → project →
// enterprise). Two properties matter and both are easy to regress:
//
//  1. Sub-field merge, not whole-block replace. An operator who sets only
//     `effort` in a project config must not lose the `enabled` their global
//     config declared. This mirrors the EarlyStopContinue precedent.
//  2. `enabled:false` in a stronger layer must WIN. Enabled is a plain bool,
//     so a naive `if src.Enabled` non-zero check would silently ignore a layer
//     whose whole purpose is to turn thinking off — the same class of bug the
//     desktop's omitted "off" sentinel caused on the wire.
//
// Revert proof: deleting the merge arm fails every case here; changing the
// Enabled carry to a non-zero check fails the disable case.
func TestMergeConfigs_ThinkingDefaultAbsentByDefault(t *testing.T) {
	result := MergeConfigs(nil, DefaultConfig())
	if result.Thinking != nil {
		t.Fatalf("Thinking = %+v, want nil (engine ships with no thinking opinion)", result.Thinking)
	}
}

func TestMergeConfigs_ThinkingDefaultCarriedFromLayer(t *testing.T) {
	base := DefaultConfig()
	layer := &types.EngineRuntimeConfig{
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "medium"},
	}
	result := MergeConfigs(nil, base, layer)
	if result.Thinking == nil {
		t.Fatal("Thinking nil; want the layer's default")
	}
	if !result.Thinking.Enabled || result.Thinking.Effort != "medium" {
		t.Errorf("Thinking = %+v, want {Enabled:true Effort:medium}", result.Thinking)
	}
}

// A later layer overriding ONE sub-field must leave the others intact.
func TestMergeConfigs_ThinkingMergesSubFields(t *testing.T) {
	base := DefaultConfig()
	global := &types.EngineRuntimeConfig{
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "low", BudgetTokens: 8000},
	}
	project := &types.EngineRuntimeConfig{
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "high"},
	}
	result := MergeConfigs(nil, base, global, project)
	if result.Thinking == nil {
		t.Fatal("Thinking nil after merge")
	}
	if result.Thinking.Effort != "high" {
		t.Errorf("Effort = %q, want high (project layer wins)", result.Thinking.Effort)
	}
	if result.Thinking.BudgetTokens != 8000 {
		t.Errorf("BudgetTokens = %d, want 8000 preserved from the global layer", result.Thinking.BudgetTokens)
	}
}

// A stronger layer that disables thinking must win over a weaker layer that
// enabled it. Enabled is a plain bool, so this is the case a non-zero-value
// merge check would silently drop.
func TestMergeConfigs_ThinkingDisableWins(t *testing.T) {
	base := DefaultConfig()
	global := &types.EngineRuntimeConfig{
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "high"},
	}
	project := &types.EngineRuntimeConfig{
		Thinking: &types.ThinkingConfig{Enabled: false},
	}
	result := MergeConfigs(nil, base, global, project)
	if result.Thinking == nil {
		t.Fatal("Thinking nil after merge")
	}
	if result.Thinking.Enabled {
		t.Error("Enabled = true, want false — a layer that disables thinking must win")
	}
}

// The pointer-bool sub-fields carry only when explicitly set, so a stronger
// layer that says nothing about them leaves the weaker layer's choice alone.
func TestMergeConfigs_ThinkingPointerBoolsCarryOnlyWhenSet(t *testing.T) {
	base := DefaultConfig()
	off := false
	global := &types.EngineRuntimeConfig{
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "low", StreamDeltas: &off},
	}
	project := &types.EngineRuntimeConfig{
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "high"},
	}
	result := MergeConfigs(nil, base, global, project)
	if result.Thinking.StreamDeltas == nil {
		t.Fatal("StreamDeltas nil; want the global layer's explicit &false preserved")
	}
	if *result.Thinking.StreamDeltas {
		t.Error("StreamDeltas = true, want false preserved from the global layer")
	}
}

// Merging must not alias the caller's config: mutating the result afterwards
// cannot be allowed to reach back into the layer it came from.
func TestMergeConfigs_ThinkingDoesNotAliasLayer(t *testing.T) {
	base := DefaultConfig()
	layer := &types.EngineRuntimeConfig{
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "medium"},
	}
	result := MergeConfigs(nil, base, layer)
	result.Thinking.Effort = "high"
	if layer.Thinking.Effort != "medium" {
		t.Errorf("source layer mutated: Effort = %q, want medium", layer.Thinking.Effort)
	}
}
