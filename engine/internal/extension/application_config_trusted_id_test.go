package extension

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestHostLoadRecordsAllowlistTrustedID pins that the allowlist identifier
// an extension passed at load becomes its trusted id, and that the name the
// extension reports in its handshake cannot change it.
func TestHostLoadRecordsAllowlistTrustedID(t *testing.T) {
	for _, tc := range []struct {
		name      string
		allowlist func(dir string) []types.ExtensionAllowlistEntry
		want      func(dir string) string
	}{
		{"allowlisted", func(dir string) []types.ExtensionAllowlistEntry {
			return []types.ExtensionAllowlistEntry{{ID: filepath.Base(dir)}}
		}, filepath.Base},
		{"no allowlist", func(string) []types.ExtensionAllowlistEntry { return nil }, func(string) string { return "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			mustWrite(t, filepath.Join(dir, "index.js"), minimalExtensionSrc)
			h := NewHost()
			t.Cleanup(func() { h.Dispose() })
			done := make(chan error, 1)
			config := &ExtensionConfig{ExtensionDir: dir, WorkingDirectory: dir, ExtensionAllowlist: tc.allowlist(dir)}
			go func() { done <- h.Load(dir, config) }()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("Load failed: %v", err)
				}
			case <-time.After(90 * time.Second):
				t.Fatal("Load timed out")
			}
			if h.Name() != "entry-test" {
				t.Fatalf("handshake did not complete: name = %q", h.Name())
			}
			if got := h.TrustedID(); got != tc.want(dir) {
				t.Fatalf("trusted id = %q, want %q", got, tc.want(dir))
			}
		})
	}
}
