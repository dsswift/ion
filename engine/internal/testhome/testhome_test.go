package testhome_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/testhome"
	"github.com/dsswift/ion/engine/internal/utils"
)

// TestEnter_RedirectsConversationStore pins the property the package exists
// for: once Enter runs, the default conversation store resolves inside the
// temp HOME, even when the caller's environment named another data root
// through ION_DATA_DIR. Restore puts both variables back and removes the
// temp HOME.
func TestEnter_RedirectsConversationStore(t *testing.T) {
	realHome := t.TempDir()
	realData := filepath.Join(t.TempDir(), "real-data-root")
	t.Setenv("HOME", realHome)
	t.Setenv("ION_DATA_DIR", realData)

	restore, err := testhome.Enter("ionh-")
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	home := os.Getenv("HOME")

	if home == realHome {
		t.Fatalf("HOME still points at the caller's home %q", realHome)
	}
	if v, ok := os.LookupEnv("ION_DATA_DIR"); ok {
		t.Fatalf("ION_DATA_DIR still set to %q", v)
	}
	if got, want := utils.IonDir(), filepath.Join(home, ".ion"); got != want {
		t.Fatalf("IonDir = %q, want %q", got, want)
	}
	convDir := conversation.DefaultConversationsDir()
	if !strings.HasPrefix(convDir, home+string(filepath.Separator)) {
		t.Fatalf("DefaultConversationsDir = %q, not under temp HOME %q", convDir, home)
	}

	restore()

	if got := os.Getenv("HOME"); got != realHome {
		t.Fatalf("HOME after restore = %q, want %q", got, realHome)
	}
	if got := os.Getenv("ION_DATA_DIR"); got != realData {
		t.Fatalf("ION_DATA_DIR after restore = %q, want %q", got, realData)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("temp HOME %q not removed after restore (stat err: %v)", home, err)
	}
}

// TestEnterDataDir_RedirectsStoreAndKeepsHome pins the data-root-only variant:
// the conversation store moves to a temp dir while HOME stays the caller's,
// and restore puts ION_DATA_DIR back and removes the temp dir.
func TestEnterDataDir_RedirectsStoreAndKeepsHome(t *testing.T) {
	realHome := t.TempDir()
	realData := filepath.Join(t.TempDir(), "real-data-root")
	t.Setenv("HOME", realHome)
	t.Setenv("ION_DATA_DIR", realData)

	restore, err := testhome.EnterDataDir("iond-")
	if err != nil {
		t.Fatalf("EnterDataDir: %v", err)
	}
	dir := os.Getenv("ION_DATA_DIR")

	if got := os.Getenv("HOME"); got != realHome {
		t.Fatalf("HOME = %q, want it left at %q", got, realHome)
	}
	if dir == realData {
		t.Fatalf("ION_DATA_DIR still points at the caller's data root %q", realData)
	}
	convDir := conversation.DefaultConversationsDir()
	if !strings.HasPrefix(convDir, dir+string(filepath.Separator)) {
		t.Fatalf("DefaultConversationsDir = %q, not under temp data root %q", convDir, dir)
	}

	restore()

	if got := os.Getenv("ION_DATA_DIR"); got != realData {
		t.Fatalf("ION_DATA_DIR after restore = %q, want %q", got, realData)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("temp data root %q not removed after restore (stat err: %v)", dir, err)
	}
}
