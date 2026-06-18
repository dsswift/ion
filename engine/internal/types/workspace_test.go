package types

import (
	"testing"
	"time"
)

func TestWorkspaceConfig_DefaultsWhenNil(t *testing.T) {
	var w *WorkspaceConfig // nil receiver
	if got := w.SessionReapGrace(); got != 5*time.Minute {
		t.Errorf("nil SessionReapGrace = %s, want 5m", got)
	}
	if got := w.MaxWatchedDirsOr(); got != 50000 {
		t.Errorf("nil MaxWatchedDirsOr = %d, want 50000", got)
	}
}

func TestWorkspaceConfig_DefaultsWhenZero(t *testing.T) {
	w := &WorkspaceConfig{} // present but unset fields
	if got := w.SessionReapGrace(); got != 5*time.Minute {
		t.Errorf("zero SessionReapGrace = %s, want 5m", got)
	}
	if got := w.MaxWatchedDirsOr(); got != 50000 {
		t.Errorf("zero MaxWatchedDirsOr = %d, want 50000", got)
	}
}

func TestWorkspaceConfig_HonorsConfiguredValues(t *testing.T) {
	w := &WorkspaceConfig{
		SessionReapGraceMs: 90000, // 90s
		MaxWatchedDirs:     1234,
	}
	if got := w.SessionReapGrace(); got != 90*time.Second {
		t.Errorf("SessionReapGrace = %s, want 90s", got)
	}
	if got := w.MaxWatchedDirsOr(); got != 1234 {
		t.Errorf("MaxWatchedDirsOr = %d, want 1234", got)
	}
}

func TestMergeWorkspace(t *testing.T) {
	// src into nil dst clones src.
	src := &WorkspaceConfig{SessionReapGraceMs: 1000, MaxWatchedDirs: 10}
	got := MergeWorkspace(nil, src)
	if got == nil || got.SessionReapGraceMs != 1000 || got.MaxWatchedDirs != 10 {
		t.Fatalf("merge into nil dst = %+v, want clone of src", got)
	}
	// mutating the result must not alias src.
	got.MaxWatchedDirs = 99
	if src.MaxWatchedDirs != 10 {
		t.Error("merge result aliases src (mutation leaked back)")
	}

	// non-zero src fields overwrite dst; zero src fields leave dst intact.
	dst := &WorkspaceConfig{SessionReapGraceMs: 1000, MaxWatchedDirs: 10}
	MergeWorkspace(dst, &WorkspaceConfig{MaxWatchedDirs: 20}) // only cap set
	if dst.SessionReapGraceMs != 1000 {
		t.Errorf("grace overwritten by zero src field: %d", dst.SessionReapGraceMs)
	}
	if dst.MaxWatchedDirs != 20 {
		t.Errorf("cap not overwritten by non-zero src: %d", dst.MaxWatchedDirs)
	}

	// nil src is a no-op.
	if MergeWorkspace(dst, nil) != dst {
		t.Error("merge with nil src should return dst unchanged")
	}
}

func TestEngineRuntimeConfig_GetWorkspace_NilSafe(t *testing.T) {
	var c *EngineRuntimeConfig
	if c.GetWorkspace() != nil {
		t.Error("nil config GetWorkspace should be nil")
	}
	// And the nil result still yields defaults through the accessor chain.
	if got := c.GetWorkspace().SessionReapGrace(); got != 5*time.Minute {
		t.Errorf("chained nil GetWorkspace().SessionReapGrace() = %s, want 5m", got)
	}

	c2 := &EngineRuntimeConfig{Workspace: &WorkspaceConfig{MaxWatchedDirs: 7}}
	if got := c2.GetWorkspace().MaxWatchedDirsOr(); got != 7 {
		t.Errorf("GetWorkspace().MaxWatchedDirsOr() = %d, want 7", got)
	}
}
