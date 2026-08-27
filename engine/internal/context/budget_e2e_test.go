package context

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Proves the budget survives a REAL walk of a real directory tree with the
// production file sizes, not a hand-built slice: nearest file admitted whole,
// outer file shed, nothing truncated.
func TestBudgetRealWalkProductionSizes(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	sub := filepath.Join(repo, "engine")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	// Mirrors the measured production shape: a ~95 KB project file and a
	// ~33 KB outer file.
	project := strings.Repeat("P", 94852)
	outer := strings.Repeat("O", 33628)
	if err := os.WriteFile(filepath.Join(sub, "AGENTS.md"), []byte(project), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "AGENTS.md"), []byte(outer), 0o644); err != nil {
		t.Fatal(err)
	}

	unbudgeted := ResolvedPolicy{IncludeProjectContext: true}
	content, files := BuildContextPrompt(sub, "engine-dev", unbudgeted)
	if len(files) != 2 {
		t.Fatalf("precondition: walk found %d files, want 2", len(files))
	}
	if len(content) < 128000 {
		t.Fatalf("precondition: unbudgeted content %d bytes, want >=128000", len(content))
	}

	// The budget ion-dev sends.
	budgeted := ResolvedPolicy{IncludeProjectContext: true, MaxContextBytes: 120_000}
	got, kept := BuildContextPrompt(sub, "engine-dev", budgeted)

	if len(kept) != 1 {
		t.Fatalf("budgeted walk kept %d files, want 1", len(kept))
	}
	if !strings.Contains(got, project) {
		t.Error("the nearest file must be admitted WHOLE")
	}
	if strings.Contains(got, outer) {
		t.Error("the outer file must be shed entirely")
	}
	if len(got) > 121000 {
		t.Errorf("budgeted content %d bytes exceeds the budget plus framing", len(got))
	}
	t.Logf("unbudgeted=%d budgeted=%d saved=%d", len(content), len(got), len(content)-len(got))
}
