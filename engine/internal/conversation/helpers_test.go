package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDefaultConversationsDir_UsesIonDataDir verifies that ION_DATA_DIR
// redirects the default conversations directory, enabling multiple engine
// instances on the same machine to use separate stores (#191).
func TestDefaultConversationsDir_UsesIonDataDir(t *testing.T) {
	t.Setenv("ION_DATA_DIR", "/custom/ion-instance")
	got := DefaultConversationsDir()
	want := filepath.Join("/custom/ion-instance", "conversations")
	if got != want {
		t.Errorf("DefaultConversationsDir() = %q, want %q", got, want)
	}
}

// TestDefaultConversationsDir_FallsBackToHomeIon verifies that when
// ION_DATA_DIR is unset the conventional ~/.ion/conversations path is returned.
func TestDefaultConversationsDir_FallsBackToHomeIon(t *testing.T) {
	// Ensure ION_DATA_DIR is unset for this test.
	t.Setenv("ION_DATA_DIR", "")

	got := DefaultConversationsDir()
	// Must end with /.ion/conversations and not be empty.
	if got == "" {
		t.Fatal("DefaultConversationsDir() returned empty string with no ION_DATA_DIR")
	}
	if !strings.HasSuffix(got, filepath.Join(".ion", "conversations")) {
		t.Errorf("DefaultConversationsDir() = %q, want suffix .ion/conversations", got)
	}
}

// TestDefaultConversationsDir_IonDataDirEmpty verifies that an explicitly
// empty ION_DATA_DIR (rare but possible) falls back to ~/.ion/conversations
// rather than returning a bare "conversations" path.
func TestDefaultConversationsDir_IonDataDirEmpty(t *testing.T) {
	orig, had := os.LookupEnv("ION_DATA_DIR")
	if had {
		defer os.Setenv("ION_DATA_DIR", orig)
	} else {
		defer os.Unsetenv("ION_DATA_DIR")
	}
	os.Unsetenv("ION_DATA_DIR")

	got := DefaultConversationsDir()
	if got == "conversations" {
		t.Errorf("DefaultConversationsDir() = %q, should not be bare 'conversations'", got)
	}
	if !strings.Contains(got, ".ion") {
		t.Errorf("DefaultConversationsDir() = %q, expected to contain .ion", got)
	}
}
