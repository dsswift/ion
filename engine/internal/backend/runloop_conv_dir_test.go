package backend

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
)

// TestRunloopConvDir_UsesIonDataDir verifies that the conversations directory
// resolved by the runloop respects ION_DATA_DIR for multi-instance deployments
// (#191). The runloop delegates to conversation.DefaultConversationsDir(), so
// this test pins that the helper — and therefore the runloop path — returns
// ION_DATA_DIR/conversations when the env var is set.
func TestRunloopConvDir_UsesIonDataDir(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("ION_DATA_DIR", dataDir)

	got := conversation.DefaultConversationsDir()
	want := filepath.Join(dataDir, "conversations")
	if got != want {
		t.Errorf("runloop convDir = %q, want %q (ION_DATA_DIR/conversations)", got, want)
	}
	if strings.Contains(got, ".ion") {
		t.Errorf("runloop convDir %q still references .ion — ION_DATA_DIR redirect not applied", got)
	}
}

// TestRunloopConvDir_FallsBackToHomeIon verifies that when ION_DATA_DIR is
// unset the runloop convDir resolves to ~/.ion/conversations (the conventional
// default), so existing single-instance deployments are unaffected.
func TestRunloopConvDir_FallsBackToHomeIon(t *testing.T) {
	t.Setenv("ION_DATA_DIR", "")

	got := conversation.DefaultConversationsDir()
	if got == "" {
		t.Fatal("runloop convDir returned empty string with no ION_DATA_DIR")
	}
	if !strings.HasSuffix(got, filepath.Join(".ion", "conversations")) {
		t.Errorf("runloop convDir = %q, want suffix .ion/conversations", got)
	}
}
