package server

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestComputeHostInfoShape(t *testing.T) {
	info := computeHostInfo()
	for _, key := range []string{"home", "username", "hostname", "os", "pathSep"} {
		if _, ok := info[key]; !ok {
			t.Errorf("expected key %q in host info", key)
		}
	}
	if got := info["os"].(string); got != runtime.GOOS {
		t.Errorf("os=%q want %q", got, runtime.GOOS)
	}
	if got := info["pathSep"].(string); got != string(os.PathSeparator) {
		t.Errorf("pathSep=%q want %q", got, string(os.PathSeparator))
	}
}

func TestResolveBrowsePath(t *testing.T) {
	home, _ := os.UserHomeDir()

	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"", home, false},
		{"~", home, false},
		{"~/Documents", filepath.Join(home, "Documents"), false},
		{"/tmp", "/tmp", false},
		{"/tmp/./foo", "/tmp/foo", false},
		{"relative/path", "", true},
		{"./also-relative", "", true},
	}
	for _, tc := range tests {
		got, err := resolveBrowsePath(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("resolveBrowsePath(%q): expected error, got %q", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("resolveBrowsePath(%q): unexpected error %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("resolveBrowsePath(%q) = %q want %q", tc.in, got, tc.want)
		}
	}
}

func TestListDirectoryBasic(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "alpha"))
	mustMkdir(t, filepath.Join(root, "Beta"))
	mustWrite(t, filepath.Join(root, "gamma.txt"))
	mustWrite(t, filepath.Join(root, ".hidden"))

	resp, err := listDirectory(root, false)
	if err != nil {
		t.Fatalf("listDirectory err: %v", err)
	}
	if resp["path"] != root {
		t.Errorf("path=%v want %v", resp["path"], root)
	}
	if resp["parent"] != filepath.Dir(root) {
		t.Errorf("parent=%v want %v", resp["parent"], filepath.Dir(root))
	}
	if resp["truncated"] != false {
		t.Errorf("truncated=true unexpected on tiny tempdir")
	}

	entries := resp["entries"].([]fsEntry)
	if len(entries) != 3 {
		t.Fatalf("entries=%d want 3 (hidden excluded). got=%+v", len(entries), entries)
	}
	// dirs first, case-insensitive: alpha, Beta, then gamma.txt
	if entries[0].Name != "alpha" || !entries[0].IsDir {
		t.Errorf("entries[0]=%+v want alpha (dir)", entries[0])
	}
	if entries[1].Name != "Beta" || !entries[1].IsDir {
		t.Errorf("entries[1]=%+v want Beta (dir)", entries[1])
	}
	if entries[2].Name != "gamma.txt" || entries[2].IsDir {
		t.Errorf("entries[2]=%+v want gamma.txt (file)", entries[2])
	}
}

func TestListDirectoryShowHidden(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "visible"))
	mustWrite(t, filepath.Join(root, ".hidden"))

	resp, err := listDirectory(root, true)
	if err != nil {
		t.Fatalf("listDirectory err: %v", err)
	}
	entries := resp["entries"].([]fsEntry)
	names := entryNames(entries)
	if !contains(names, ".hidden") {
		t.Errorf(".hidden missing from entries with showHidden=true: %v", names)
	}
	if !contains(names, "visible") {
		t.Errorf("visible missing from entries: %v", names)
	}
}

func TestListDirectoryRejectsRelativePath(t *testing.T) {
	if _, err := listDirectory("relative/path", false); err == nil {
		t.Fatal("expected error for relative path")
	}
}

func TestListDirectoryResolvesHomeShortcut(t *testing.T) {
	resp, err := listDirectory("~", false)
	if err != nil {
		t.Fatalf("listDirectory(~) err: %v", err)
	}
	home, _ := os.UserHomeDir()
	if resp["path"] != home {
		t.Errorf("~ resolved to %v want %v", resp["path"], home)
	}
}

func TestListDirectoryMissingPath(t *testing.T) {
	// /nonexistent on every platform we ship to
	bad := filepath.Join(t.TempDir(), "does-not-exist")
	if _, err := listDirectory(bad, false); err == nil {
		t.Fatal("expected error for missing directory")
	}
}

// helpers

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.Mkdir(p, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", p, err)
	}
}

func mustWrite(t *testing.T, p string) {
	t.Helper()
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
}

func entryNames(entries []fsEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Name
	}
	return out
}

func contains(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}

// silence unused import warnings for runtime if some test paths drop GOOS use
var _ = strings.HasPrefix
