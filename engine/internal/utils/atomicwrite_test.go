package utils

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWriteFile_CreatesNewFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "new.json")

	if err := AtomicWriteFile(path, []byte(`{"ok":true}`), 0o644); err != nil {
		t.Fatalf("AtomicWriteFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != `{"ok":true}` {
		t.Errorf("content = %q, want %q", got, `{"ok":true}`)
	}
}

func TestAtomicWriteFile_OverwritesExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWriteFile(path, []byte("new"), 0o644); err != nil {
		t.Fatalf("AtomicWriteFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Errorf("content = %q, want %q", got, "new")
	}
}

func TestAtomicWriteFile_CreatesParentDirs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "deep", "file.json")

	if err := AtomicWriteFile(path, []byte("data"), 0o600); err != nil {
		t.Fatalf("AtomicWriteFile: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("file not created: %v", err)
	}
}

func TestAtomicWriteFile_SetsPermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "perms.json")

	if err := AtomicWriteFile(path, []byte("secret"), 0o600); err != nil {
		t.Fatalf("AtomicWriteFile: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}
}

func TestAtomicWriteFile_NoTempLeftOnSuccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "clean.json")

	if err := AtomicWriteFile(path, []byte("data"), 0o644); err != nil {
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

func TestAtomicWriteFile_OriginalSurvivesOnBadDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "survive.json")
	if err := os.WriteFile(path, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}

	badPath := filepath.Join(dir, "noexist", "impossible", "nested", "file.json")
	if err := os.MkdirAll(filepath.Dir(badPath), 0o000); err != nil {
		t.Skip("cannot restrict dir permissions (e.g. running as root)")
	}
	deepBad := filepath.Join(filepath.Dir(badPath), "deeper", "file.json")
	err := AtomicWriteFile(deepBad, []byte("should fail"), 0o644)
	if err == nil {
		t.Fatal("expected error writing to restricted directory")
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "original" {
		t.Errorf("original content corrupted: %q", got)
	}
}

func TestAtomicWriteFile_EmptyData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.json")

	if err := AtomicWriteFile(path, []byte{}, 0o644); err != nil {
		t.Fatalf("AtomicWriteFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty file, got %d bytes", len(got))
	}
}
