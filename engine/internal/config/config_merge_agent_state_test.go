package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func intPtrCfg(v int) *int { return &v }

// The agent-state blocks are documented engine.json settings, so a value set
// in any layer must survive the merge onto the compiled defaults.
func TestMergeLimits_AgentStateBlocksSurviveLayering(t *testing.T) {
	global := &types.EngineRuntimeConfig{Limits: types.LimitsConfig{
		AgentStateEmit:     &types.AgentStateEmitLimits{CoalesceMs: intPtrCfg(-1)},
		AgentStateMetadata: &types.AgentStateMetadataLimits{MaxValueBytes: intPtrCfg(1024)},
	}}

	merged := MergeConfigs(nil, DefaultConfig(), global, &types.EngineRuntimeConfig{})

	if merged.Limits.AgentStateEmit == nil || merged.Limits.AgentStateEmit.Resolved().CoalesceMs != -1 {
		t.Errorf("limits.agentStateEmit lost in merge: %+v", merged.Limits.AgentStateEmit)
	}
	if merged.Limits.AgentStateMetadata == nil || merged.Limits.AgentStateMetadata.MaxValueBytes == nil || *merged.Limits.AgentStateMetadata.MaxValueBytes != 1024 {
		t.Errorf("limits.agentStateMetadata lost in merge: %+v", merged.Limits.AgentStateMetadata)
	}
}

// A higher layer that sets one field of a block keeps the lower layer's other
// fields, matching how every other pointer-field block merges.
func TestMergeLimits_AgentStateBlocksMergeFieldByField(t *testing.T) {
	dedupOff := false
	global := &types.EngineRuntimeConfig{Limits: types.LimitsConfig{
		AgentStateEmit:     &types.AgentStateEmitLimits{CoalesceMs: intPtrCfg(500), Dedup: &dedupOff},
		AgentStateMetadata: &types.AgentStateMetadataLimits{MaxValueBytes: intPtrCfg(1024), MaxDepth: intPtrCfg(2)},
	}}
	project := &types.EngineRuntimeConfig{Limits: types.LimitsConfig{
		AgentStateEmit:     &types.AgentStateEmitLimits{CoalesceMs: intPtrCfg(100)},
		AgentStateMetadata: &types.AgentStateMetadataLimits{MaxDepth: intPtrCfg(3)},
	}}

	merged := MergeConfigs(nil, DefaultConfig(), global, project)

	emit := merged.Limits.AgentStateEmit.Resolved()
	if emit.CoalesceMs != 100 || emit.Dedup {
		t.Errorf("agentStateEmit = %+v, want coalesceMs 100 from project and dedup false from global", emit)
	}
	meta := merged.Limits.AgentStateMetadata
	if meta == nil || meta.MaxValueBytes == nil || *meta.MaxValueBytes != 1024 || meta.MaxDepth == nil || *meta.MaxDepth != 3 {
		t.Errorf("agentStateMetadata = %+v, want maxValueBytes 1024 from global and maxDepth 3 from project", meta)
	}
	if global.Limits.AgentStateEmit.CoalesceMs == nil || *global.Limits.AgentStateEmit.CoalesceMs != 500 {
		t.Error("merge mutated the global layer's block")
	}
}
