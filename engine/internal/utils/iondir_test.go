package utils

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestIonDir_EnvWins asserts ION_DATA_DIR is returned verbatim, with no
// expansion or join, when set.
func TestIonDir_EnvWins(t *testing.T) {
	t.Setenv("ION_DATA_DIR", "/tmp/ion-a")
	t.Setenv("HOME", t.TempDir())
	if got := IonDir(); got != "/tmp/ion-a" {
		t.Fatalf("IonDir() = %q, want %q", got, "/tmp/ion-a")
	}
}

// TestIonDir_HomeDefault asserts the conventional <home>/.ion path is
// returned when ION_DATA_DIR is unset.
func TestIonDir_HomeDefault(t *testing.T) {
	t.Setenv("ION_DATA_DIR", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	want := filepath.Join(home, ".ion")
	if got := IonDir(); got != want {
		t.Fatalf("IonDir() = %q, want %q", got, want)
	}
}

// TestIonDir_Empty asserts an empty string is returned (with a WARN log,
// not verified here) when neither ION_DATA_DIR nor HOME resolves a home.
func TestIonDir_Empty(t *testing.T) {
	t.Setenv("ION_DATA_DIR", "")
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "") // os.UserHomeDir's Windows source
	if got := IonDir(); got != "" {
		t.Fatalf("IonDir() = %q, want empty string", got)
	}
}

// TestNoStrayIonJoins walks the engine tree and fails on any new
// filepath.Join(..., ".ion", ...) or literal ".ion" home join outside this
// file. Every data-root path must derive from IonDir() so there is exactly
// one place that knows how to find the engine's data directory.
func TestNoStrayIonJoins(t *testing.T) {
	root := ".." + string(filepath.Separator) + ".."
	// Also a "~/.ion" literal expanded against HOME: it ignores ION_DATA_DIR,
	// so an engine with its own data root wrote such files into the
	// operator's ~/.ion (telemetry retry queues did exactly this).
	strayPattern := regexp.MustCompile(`Join\((home|homeDir)\s*,\s*"\.ion"|ExpandHomePath\((fmt\.Sprintf\()?"~/\.ion`)

	var offenders []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if info.Name() == "node_modules" || info.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}
		base := filepath.Base(path)
		if base == "iondir.go" {
			return nil
		}
		data, readErr := os.ReadFile(path) //nolint:gosec // walking the engine's own tree at test time
		if readErr != nil {
			return readErr
		}
		if strayPattern.Match(data) {
			offenders = append(offenders, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk failed: %v", err)
	}
	if len(offenders) > 0 {
		t.Fatalf("stray home/.ion paths found outside iondir.go (use utils.IonDir()): %v", offenders)
	}
}
