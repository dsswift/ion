package types

import "testing"

func intPtr(v int) *int { return &v }

func TestAgentStateMetadataLimits_NilResolvesToDefaults(t *testing.T) {
	var l *AgentStateMetadataLimits
	got := l.Resolved()

	if got != AgentStateMetadataDefaults() {
		t.Errorf("nil config resolved to %+v, want compiled defaults %+v", got, AgentStateMetadataDefaults())
	}
}

// A zero value means "unset", not "zero bytes". Treating it literally would
// clamp every value to nothing the moment a partial config block appeared.
func TestAgentStateMetadataLimits_ZeroMeansDefault(t *testing.T) {
	l := &AgentStateMetadataLimits{MaxValueBytes: intPtr(0)}
	if got := l.Resolved().MaxValueBytes; got != DefaultAgentStateMaxValueBytes {
		t.Errorf("MaxValueBytes = %d, want default %d", got, DefaultAgentStateMaxValueBytes)
	}
}

func TestAgentStateMetadataLimits_ExplicitValuesWin(t *testing.T) {
	l := &AgentStateMetadataLimits{
		MaxValueBytes:    intPtr(1024),
		MaxEntryBytes:    intPtr(2048),
		MaxSnapshotBytes: intPtr(4096),
		MaxDepth:         intPtr(2),
	}
	got := l.Resolved()

	if got.MaxValueBytes != 1024 || got.MaxEntryBytes != 2048 ||
		got.MaxSnapshotBytes != 4096 || got.MaxDepth != 2 {
		t.Errorf("explicit config not honored: %+v", got)
	}
}

func TestAgentStateMetadataLimits_NegativeOneDisables(t *testing.T) {
	l := &AgentStateMetadataLimits{MaxValueBytes: intPtr(-1)}
	if got := l.Resolved().MaxValueBytes; got != -1 {
		t.Errorf("MaxValueBytes = %d, want -1 (disabled) to survive resolution", got)
	}
}

func TestEnterpriseCeiling_NarrowsButNeverLoosens(t *testing.T) {
	resolved := ResolvedAgentStateMetadataLimits{
		MaxValueBytes: 8192, MaxEntryBytes: 1024, MaxSnapshotBytes: 100,
	}
	ceiling := &EnterpriseAgentStateMetadataLimits{
		MaxValueBytes:    intPtr(4096),  // tighter -> wins
		MaxEntryBytes:    intPtr(65536), // looser  -> ignored
		MaxSnapshotBytes: intPtr(4096),  // looser  -> ignored
	}

	got := ceiling.ApplyCeiling(resolved)

	if got.MaxValueBytes != 4096 {
		t.Errorf("MaxValueBytes = %d, want the tighter enterprise value 4096", got.MaxValueBytes)
	}
	if got.MaxEntryBytes != 1024 {
		t.Errorf("MaxEntryBytes = %d, want the tighter local value 1024 (ceiling must not loosen)", got.MaxEntryBytes)
	}
	if got.MaxSnapshotBytes != 100 {
		t.Errorf("MaxSnapshotBytes = %d, want the tighter local value 100", got.MaxSnapshotBytes)
	}
}

// The dangerous case: a local config disabling a tier the enterprise bounded.
// -1 means unbounded, so any real ceiling is tighter and must win. A naive
// numeric MIN would pick -1 and hand the local layer a way to switch off
// enterprise policy.
func TestEnterpriseCeiling_OverridesLocallyDisabledTier(t *testing.T) {
	resolved := ResolvedAgentStateMetadataLimits{MaxValueBytes: -1}
	ceiling := &EnterpriseAgentStateMetadataLimits{MaxValueBytes: intPtr(4096)}

	if got := ceiling.ApplyCeiling(resolved).MaxValueBytes; got != 4096 {
		t.Errorf("MaxValueBytes = %d, want 4096: a local -1 must not defeat an enterprise ceiling", got)
	}
}

func TestEnterpriseCeiling_NilIsPassthrough(t *testing.T) {
	resolved := ResolvedAgentStateMetadataLimits{MaxValueBytes: 8192}
	var ceiling *EnterpriseAgentStateMetadataLimits

	if got := ceiling.ApplyCeiling(resolved); got != resolved {
		t.Errorf("nil ceiling changed limits: %+v", got)
	}
}

func TestAgentStateEmitLimits_NilResolvesToDefaults(t *testing.T) {
	var l *AgentStateEmitLimits
	got := l.Resolved()

	if got.CoalesceMs != DefaultAgentStateCoalesceMs {
		t.Errorf("CoalesceMs = %d, want %d", got.CoalesceMs, DefaultAgentStateCoalesceMs)
	}
	if !got.Dedup {
		t.Error("Dedup should default to enabled")
	}
}

// -1 is the escape hatch for a consumer that depends on emission cardinality.
// It must survive resolution rather than being read as "unset".
func TestAgentStateEmitLimits_NegativeOneDisablesCoalescing(t *testing.T) {
	l := &AgentStateEmitLimits{CoalesceMs: intPtr(-1)}
	if got := l.Resolved().CoalesceMs; got != -1 {
		t.Errorf("CoalesceMs = %d, want -1 to survive resolution", got)
	}
}

func TestAgentStateEmitLimits_ZeroMeansDefault(t *testing.T) {
	l := &AgentStateEmitLimits{CoalesceMs: intPtr(0)}
	if got := l.Resolved().CoalesceMs; got != DefaultAgentStateCoalesceMs {
		t.Errorf("CoalesceMs = %d, want the default %d", got, DefaultAgentStateCoalesceMs)
	}
}

// Dedup is a bool, so false must be distinguishable from unset -- which is
// exactly why the config field is a pointer.
func TestAgentStateEmitLimits_DedupFalseIsHonored(t *testing.T) {
	l := &AgentStateEmitLimits{Dedup: boolPtr(false)}
	if l.Resolved().Dedup {
		t.Error("explicit dedup:false must be honored, not treated as unset")
	}
}
