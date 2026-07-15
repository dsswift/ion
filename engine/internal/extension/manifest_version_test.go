package extension

import (
	"os"
	"path/filepath"
	"testing"
)

// TestManifestVersion_ParsesField verifies that the new "version" field is
// accepted by LoadManifest (DisallowUnknownFields used to reject it before this
// change) and that the parsed value lands on Manifest.Version.
//
// RED on unfixed code: LoadManifest returns an error ("unknown field version")
// because DisallowUnknownFields rejected the unknown key before we added the
// field to the struct.
func TestManifestVersion_ParsesField(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "extension.json"), []byte(`{
		"name": "my-ext",
		"version": "1.2.3"
	}`), 0o644); err != nil {
		t.Fatalf("write extension.json: %v", err)
	}

	m, err := LoadManifest(dir)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}
	if m == nil {
		t.Fatal("LoadManifest returned nil manifest; expected non-nil")
	}
	if m.Version != "1.2.3" {
		t.Errorf("Version = %q, want %q", m.Version, "1.2.3")
	}
	if m.Name != "my-ext" {
		t.Errorf("Name = %q, want %q", m.Name, "my-ext")
	}
}

// TestManifestVersion_AbsentDefaultsEmpty verifies that a manifest without the
// "version" field leaves Manifest.Version as the empty string (additive
// evolution: old manifests are unaffected).
func TestManifestVersion_AbsentDefaultsEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "extension.json"), []byte(`{
		"name": "no-version-ext"
	}`), 0o644); err != nil {
		t.Fatalf("write extension.json: %v", err)
	}

	m, err := LoadManifest(dir)
	if err != nil {
		t.Fatalf("LoadManifest returned error: %v", err)
	}
	if m == nil {
		t.Fatal("LoadManifest returned nil manifest; expected non-nil")
	}
	if m.Version != "" {
		t.Errorf("Version = %q, want empty string for manifest without version", m.Version)
	}
}
