package extension

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The duplicate fields ride the context_discover payload to subprocess
// extensions; pin their wire names and omission when empty.
func TestContextDiscoverInfo_DuplicateFieldsSerialize(t *testing.T) {
	b, err := json.Marshal(ContextDiscoverInfo{Path: "/p/CLAUDE.md", Source: "project", DuplicateOf: "/p/AGENTS.md", DuplicateReason: "symlink"})
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	for _, want := range []string{`"duplicateOf":"/p/AGENTS.md"`, `"duplicateReason":"symlink"`} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %s in %s", want, got)
		}
	}
	plain, _ := json.Marshal(ContextDiscoverInfo{Path: "/p/AGENTS.md", Source: "project"}) //nolint:errcheck // marshaling a plain struct cannot fail
	if strings.Contains(string(plain), "duplicate") {
		t.Fatalf("empty duplicate fields must be omitted: %s", plain)
	}
}

func TestWalkContextFilesForExtension_IncludeMaxDepth(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{"AGENTS.md": "@one.md", "one.md": "ONE\n@two.md", "two.md": "TWO"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	off := false
	files := walkContextFilesForExtension(WalkContextFilesRequest{Cwd: dir, IncludeGlobal: &off, IncludeMaxDepth: 1})
	if len(files) == 0 {
		t.Fatal("no files walked")
	}
	if strings.Contains(files[0].Content, "TWO") || !strings.Contains(files[0].Content, "max include depth reached") {
		t.Fatalf("includeMaxDepth not applied: %q", files[0].Content)
	}
}
