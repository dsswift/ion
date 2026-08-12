package atomicwrite

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFile_CreatesNewFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "new.json")

	if err := File(path, []byte(`{"ok":true}`), 0o644); err != nil {
		t.Fatalf("File: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != `{"ok":true}` {
		t.Errorf("content = %q, want %q", got, `{"ok":true}`)
	}
}

func TestFile_OverwritesExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := File(path, []byte("new"), 0o644); err != nil {
		t.Fatalf("File: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Errorf("content = %q, want %q", got, "new")
	}
}

func TestFile_SetsPermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "perms.json")

	if err := File(path, []byte("secret"), 0o600); err != nil {
		t.Fatalf("File: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}
}

func TestFile_NoTempLeftOnSuccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "clean.json")

	if err := File(path, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Errorf("expected 1 file, got %d: %v", len(entries), names)
	}
}

func TestFile_CreatesParentDirs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "deep", "file.json")

	if err := File(path, []byte("nested"), 0o644); err != nil {
		t.Fatalf("File: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("file not created: %v", err)
	}
}
