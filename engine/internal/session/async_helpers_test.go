package session

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestDefaultSchedulerPersistDir_UsesIonDataDir verifies that ION_DATA_DIR
// redirects the scheduler persist directory so multiple engine instances on
// the same machine use separate last-run marker stores (#191).
func TestDefaultSchedulerPersistDir_UsesIonDataDir(t *testing.T) {
	t.Setenv("ION_DATA_DIR", "/custom/ion-instance")
	got := defaultSchedulerPersistDir()
	want := filepath.Join("/custom/ion-instance", "scheduler")
	if got != want {
		t.Errorf("defaultSchedulerPersistDir() = %q, want %q", got, want)
	}
}

// TestDefaultSchedulerPersistDir_FallsBackToHomeIon verifies that when
// ION_DATA_DIR is unset the conventional ~/.ion/scheduler path is returned.
func TestDefaultSchedulerPersistDir_FallsBackToHomeIon(t *testing.T) {
	t.Setenv("ION_DATA_DIR", "")
	got := defaultSchedulerPersistDir()
	if got == "" {
		t.Fatal("defaultSchedulerPersistDir() returned empty string with no ION_DATA_DIR")
	}
	if !strings.HasSuffix(got, filepath.Join(".ion", "scheduler")) {
		t.Errorf("defaultSchedulerPersistDir() = %q, want suffix .ion/scheduler", got)
	}
}
