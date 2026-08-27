package context

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Context injection repeats full file content on EVERY dispatch. In production
// a single ~33 KB global AGENTS.md was prepended to every dispatch of a
// four-agent fan-out, and a worktree case reached ~128 KB across two files —
// paid per dispatch, before the task text, whether or not the child did any
// work. MaxContextBytes bounds that.
//
// The load-bearing property is WHOLE-FILE inclusion. Half an instruction file
// is worse than none: the agent cannot tell which rules it did not receive and
// acts with confident partial knowledge. These tests pin that, and pin that
// the default (no budget) is completely unchanged.

// The historic behavior: no budget configured means every file is included.
func TestApplyContextBudget_ZeroMeansUnlimited(t *testing.T) {
	files := []DiscoveredContext{
		{Path: "/a/AGENTS.md", Content: strings.Repeat("x", 5000)},
		{Path: "/b/AGENTS.md", Content: strings.Repeat("y", 5000)},
	}

	for _, budget := range []int{0, -1} {
		got := applyContextBudget(files, budget, "/a", "test")
		if len(got) != 2 {
			t.Errorf("budget %d: kept %d files, want all 2", budget, len(got))
		}
	}
}

// A walk that fits is passed through untouched.
func TestApplyContextBudget_WithinLimitKeepsEverything(t *testing.T) {
	files := []DiscoveredContext{
		{Path: "/a/AGENTS.md", Content: strings.Repeat("x", 100)},
		{Path: "/b/AGENTS.md", Content: strings.Repeat("y", 100)},
	}

	got := applyContextBudget(files, 1000, "/a", "test")

	if len(got) != 2 {
		t.Errorf("kept %d files, want 2", len(got))
	}
}

// The core guarantee: a file that does not fit is dropped ENTIRELY, never
// sliced. Every kept file must be byte-identical to its input.
func TestApplyContextBudget_NeverTruncatesAFile(t *testing.T) {
	nearContent := strings.Repeat("n", 400)
	farContent := strings.Repeat("f", 400)
	files := []DiscoveredContext{
		{Path: "/deep/AGENTS.md", Content: nearContent},
		{Path: "/home/AGENTS.md", Content: farContent},
	}

	// Budget fits the first file but not both.
	got := applyContextBudget(files, 500, "/deep", "test")

	if len(got) != 1 {
		t.Fatalf("kept %d files, want 1", len(got))
	}
	if got[0].Content != nearContent {
		t.Error("a kept file must be byte-identical: no mid-file truncation")
	}
	if len(got[0].Content) != 400 {
		t.Errorf("kept content = %d bytes, want the full 400", len(got[0].Content))
	}
}

// Walk order is nearest-first (cwd, then ancestors, then home roots), so the
// budget keeps the files most specific to the child's working directory. A
// child working in one repo should keep that repo's guidance and shed the
// global file, not the reverse.
func TestApplyContextBudget_KeepsNearestFirst(t *testing.T) {
	files := []DiscoveredContext{
		{Path: "/repo/sub/AGENTS.md", Content: strings.Repeat("a", 100), Source: "project"},
		{Path: "/repo/AGENTS.md", Content: strings.Repeat("b", 100), Source: "parent"},
		{Path: "/home/.ion/AGENTS.md", Content: strings.Repeat("c", 100), Source: "global"},
	}

	got := applyContextBudget(files, 250, "/repo/sub", "test")

	if len(got) != 2 {
		t.Fatalf("kept %d files, want 2", len(got))
	}
	if got[0].Path != "/repo/sub/AGENTS.md" || got[1].Path != "/repo/AGENTS.md" {
		t.Errorf("kept %q and %q, want the two nearest files", got[0].Path, got[1].Path)
	}
}

// A large file early in the walk must not starve smaller later files out of a
// budget they would fit in. Skipping is per-file, not "stop at the first
// overflow".
func TestApplyContextBudget_SmallLaterFileSurvivesLargeEarlierSkip(t *testing.T) {
	files := []DiscoveredContext{
		{Path: "/huge/AGENTS.md", Content: strings.Repeat("h", 5000)},
		{Path: "/small/AGENTS.md", Content: strings.Repeat("s", 100)},
	}

	got := applyContextBudget(files, 1000, "/huge", "test")

	if len(got) != 1 {
		t.Fatalf("kept %d files, want 1", len(got))
	}
	if got[0].Path != "/small/AGENTS.md" {
		t.Errorf("kept %q, want the small file that fits", got[0].Path)
	}
}

// A budget smaller than every file yields nothing rather than a fragment.
func TestApplyContextBudget_AllFilesTooLargeYieldsNone(t *testing.T) {
	files := []DiscoveredContext{
		{Path: "/a/AGENTS.md", Content: strings.Repeat("x", 5000)},
	}

	got := applyContextBudget(files, 100, "/a", "test")

	if len(got) != 0 {
		t.Errorf("kept %d files, want 0 (a fragment is worse than nothing)", len(got))
	}
}

// End-to-end through BuildContextPrompt: the budget reaches the real walk, and
// the returned file list reflects what was actually included so the caller's
// byte accounting stays truthful.
func TestBuildContextPrompt_BudgetSkipsWholeFiles(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "nested")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	nearBody := strings.Repeat("N", 300)
	farBody := strings.Repeat("F", 300)
	if err := os.WriteFile(filepath.Join(sub, "AGENTS.md"), []byte(nearBody), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(farBody), 0o644); err != nil {
		t.Fatal(err)
	}

	// Unbudgeted: both files arrive.
	unbudgeted := ResolvedPolicy{IncludeProjectContext: true}
	_, allFiles := BuildContextPrompt(sub, "test", unbudgeted)
	if len(allFiles) != 2 {
		t.Fatalf("unbudgeted walk found %d files, want 2 (fixture precondition)", len(allFiles))
	}

	// Budgeted to fit only one.
	budgeted := ResolvedPolicy{IncludeProjectContext: true, MaxContextBytes: 400}
	content, files := BuildContextPrompt(sub, "test", budgeted)

	if len(files) != 1 {
		t.Fatalf("budgeted walk kept %d files, want 1", len(files))
	}
	if !strings.Contains(content, nearBody) {
		t.Error("the nearest file's full content must be present")
	}
	if strings.Contains(content, farBody) {
		t.Error("the skipped file's content must be absent entirely")
	}
}

// The budget resolves through the same four-level cascade as the other context
// fields, and only a POSITIVE value overrides — so a higher level that never
// mentions a budget cannot silently erase a lower level's.
func TestResolvePolicy_MaxContextBytesCascade(t *testing.T) {
	engineCfg := &types.DispatchContextConfig{MaxContextBytes: 10000}

	// Level 2 alone.
	got := ResolvePolicy(nil, nil, engineCfg, false)
	if got.MaxContextBytes != 10000 {
		t.Errorf("engine-level budget = %d, want 10000", got.MaxContextBytes)
	}

	// Per-dispatch overrides engine config.
	perDispatch := &types.DispatchContextConfig{MaxContextBytes: 500}
	got = ResolvePolicy(perDispatch, nil, engineCfg, false)
	if got.MaxContextBytes != 500 {
		t.Errorf("per-dispatch budget = %d, want 500", got.MaxContextBytes)
	}

	// A higher level that omits the field inherits rather than erasing.
	silentHigher := &types.DispatchContextConfig{}
	got = ResolvePolicy(silentHigher, nil, engineCfg, false)
	if got.MaxContextBytes != 10000 {
		t.Errorf("budget after silent higher level = %d, want 10000 inherited", got.MaxContextBytes)
	}

	// No config anywhere means unlimited.
	got = ResolvePolicy(nil, nil, nil, false)
	if got.MaxContextBytes != 0 {
		t.Errorf("default budget = %d, want 0 (unlimited)", got.MaxContextBytes)
	}
}
