package extension

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestResolveExtensionEntry_NativeEntryNamesPlatform pins that the native
// entry probe uses this platform's own filename (main on unix, main.exe on
// windows) and reports it in the not-found error.
func TestResolveExtensionEntry_NativeEntryNamesPlatform(t *testing.T) {
	dir := t.TempDir()
	mustWriteExecutable(t, filepath.Join(dir, nativeEntryName), "#!/bin/sh\nexit 0\n")

	entry, err := resolveExtensionEntry(dir)
	if err != nil {
		t.Fatalf("resolveExtensionEntry: %v", err)
	}
	if filepath.Base(entry) != nativeEntryName {
		t.Errorf("entry = %s, want %s", entry, nativeEntryName)
	}
}

// TestResolveExtensionEntry_MissEmptyDirNamesNativeEntry asserts the
// not-found error names this platform's native entry filename among the
// probed candidates.
func TestResolveExtensionEntry_MissEmptyDirNamesNativeEntry(t *testing.T) {
	dir := t.TempDir()
	_, err := resolveExtensionEntry(dir)
	if err == nil {
		t.Fatal("expected error for empty directory")
	}
	if got := err.Error(); !strings.Contains(got, nativeEntryName) {
		t.Errorf("error %q should name the native entry %q", got, nativeEntryName)
	}
}
