package session

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestNewPerPromptExtensionHost_PropagatesBuildIdentity(t *testing.T) {
	abs := func(segments ...string) string {
		if runtime.GOOS == "windows" {
			return `C:\` + filepath.Join(segments...)
		}
		return "/" + filepath.Join(segments...)
	}
	identity := "release-build-id"
	entryPath := abs("tmp", "example", "index.ts")
	wantDir := abs("tmp", "example")
	host, config := newPerPromptExtensionHost(identity, entryPath, abs("tmp", "project"))

	if got := host.EngineBuildIdentity(); got != identity {
		t.Errorf("host identity = %q, want %q", got, identity)
	}
	if got := config.BuildIdentity; got != identity {
		t.Errorf("config identity = %q, want %q", got, identity)
	}
	// filepath.Dir normalizes to the platform's own separator regardless of
	// which separator the input used, so the expected value is built the
	// same way rather than hardcoded with forward slashes.
	if got := config.ExtensionDir; got != wantDir {
		t.Errorf("extension directory = %q, want %q", got, wantDir)
	}
}
