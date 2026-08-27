package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// The sub-agent early-stop scope used to be HARDCODED off: no engine.json key,
// no RunOptions field, nothing an operator could set. That made one
// engine-chosen behavior mandatory where consumers reasonably differ, which is
// the "forcing a consumer to do something exactly one way" anti-pattern.
//
// SubagentEnabled makes the scope configurable while preserving the default
// exactly. These tests pin both halves — the preserved default matters as much
// as the new capability, because a silent behavior change to every dispatched
// agent on the machine would be far worse than the gap being closed.

func subagentBoolPtr(b bool) *bool { return &b }

// The historic default: nil SubagentEnabled means sub-agents stay out of the
// early-stop gate, reported as source "subagentDefault".
func TestMergeEarlyStopConfig_SubagentNilPreservesHardBlock(t *testing.T) {
	enabled := true
	cfg := &RunConfig{EarlyStopContinue: &types.EarlyStopContinueConfig{
		Enabled: &enabled,
		Budget:  8000,
	}}

	got := mergeEarlyStopConfig(types.RunOptions{IsSubagent: true}, cfg)

	if got.enabled {
		t.Error("sub-agent with nil SubagentEnabled must remain disabled")
	}
	if got.source != "subagentDefault" {
		t.Errorf("source = %q, want subagentDefault", got.source)
	}
}

// A completely absent EarlyStopContinue block must behave identically to nil
// SubagentEnabled — this is the shape every existing engine.json on disk has.
func TestMergeEarlyStopConfig_SubagentAbsentConfigPreservesHardBlock(t *testing.T) {
	got := mergeEarlyStopConfig(types.RunOptions{IsSubagent: true}, &RunConfig{})

	if got.enabled {
		t.Error("sub-agent with no EarlyStopContinue block must remain disabled")
	}
	if got.source != "subagentDefault" {
		t.Errorf("source = %q, want subagentDefault", got.source)
	}
}

// The new capability: an operator opts sub-agents in via engine.json and the
// gate applies to them. Source records that the scope decision came from
// config, so the log distinguishes it from the historic hard block.
func TestMergeEarlyStopConfig_SubagentEnabledOpensGate(t *testing.T) {
	enabled := true
	cfg := &RunConfig{EarlyStopContinue: &types.EarlyStopContinueConfig{
		Enabled:         &enabled,
		Budget:          8000,
		SubagentEnabled: subagentBoolPtr(true),
	}}

	got := mergeEarlyStopConfig(types.RunOptions{IsSubagent: true}, cfg)

	if !got.enabled {
		t.Error("SubagentEnabled=true must let the gate apply to sub-agents")
	}
	if got.source != "subagentConfig" {
		t.Errorf("source = %q, want subagentConfig", got.source)
	}
}

// Opting sub-agents into the SCOPE does not enable the feature outright. When
// the feature itself is off, opting in the sub-agent scope must not turn it on
// — the scope selector and the kill switch are different controls.
func TestMergeEarlyStopConfig_SubagentEnabledDoesNotOverrideGlobalOff(t *testing.T) {
	disabled := false
	cfg := &RunConfig{EarlyStopContinue: &types.EarlyStopContinueConfig{
		Enabled:         &disabled,
		Budget:          8000,
		SubagentEnabled: subagentBoolPtr(true),
	}}

	got := mergeEarlyStopConfig(types.RunOptions{IsSubagent: true}, cfg)

	if got.enabled {
		t.Error("SubagentEnabled must not override the global kill switch")
	}
}

// Explicit false is equivalent to the default block, and says so in the log.
func TestMergeEarlyStopConfig_SubagentExplicitFalseBlocks(t *testing.T) {
	enabled := true
	cfg := &RunConfig{EarlyStopContinue: &types.EarlyStopContinueConfig{
		Enabled:         &enabled,
		Budget:          8000,
		SubagentEnabled: subagentBoolPtr(false),
	}}

	got := mergeEarlyStopConfig(types.RunOptions{IsSubagent: true}, cfg)

	if got.enabled {
		t.Error("SubagentEnabled=false must keep sub-agents disabled")
	}
	if got.source != "subagentDefault" {
		t.Errorf("source = %q, want subagentDefault", got.source)
	}
}

// The per-run override still wins over everything, unchanged. A harness that
// forces on for one dispatch must not be second-guessed by machine config.
func TestMergeEarlyStopConfig_PerRunOverrideStillWinsForSubagents(t *testing.T) {
	enabled := true
	cfg := &RunConfig{EarlyStopContinue: &types.EarlyStopContinueConfig{
		Enabled:         &enabled,
		Budget:          8000,
		SubagentEnabled: subagentBoolPtr(false),
	}}
	forceOn := true

	got := mergeEarlyStopConfig(types.RunOptions{
		IsSubagent:       true,
		EarlyStopEnabled: &forceOn,
	}, cfg)

	if !got.enabled {
		t.Error("per-run EarlyStopEnabled=true must win over SubagentEnabled=false")
	}
}

// Root runs are untouched by the sub-agent scope selector in either direction.
func TestMergeEarlyStopConfig_RootRunsIgnoreSubagentSetting(t *testing.T) {
	enabled := true
	for _, subagentOptIn := range []bool{true, false} {
		cfg := &RunConfig{EarlyStopContinue: &types.EarlyStopContinueConfig{
			Enabled:         &enabled,
			Budget:          8000,
			SubagentEnabled: subagentBoolPtr(subagentOptIn),
		}}

		got := mergeEarlyStopConfig(types.RunOptions{IsSubagent: false}, cfg)

		if !got.enabled {
			t.Errorf("root run with SubagentEnabled=%v must stay enabled", subagentOptIn)
		}
		if got.source == "subagentDefault" || got.source == "subagentConfig" {
			t.Errorf("root run source = %q, must not take a sub-agent branch", got.source)
		}
	}
}
