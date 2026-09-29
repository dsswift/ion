package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// forkFixture builds a source conversation whose history names a plan in its
// own folder, a legacy shared plan, a spilled tool result, and an attached
// plan, then forks it. Nothing is saved; CopyOwnedFilesForFork runs between
// building and saving a fork.
type forkFixture struct {
	source, forked               *Conversation
	ownedPlan, legacyPlan, spill string
}

func newForkFixture(t *testing.T) forkFixture {
	t.Helper()
	t.Setenv("ION_DATA_DIR", t.TempDir())
	source := CreateConversation("src-conv", "system", "model")

	ownedPlan := filepath.Join(PlansDir(source.ID), "calm-jumping-fox.md")
	writeTestFile(t, ownedPlan, "owned plan v1")
	legacyPlan := filepath.Join(filepath.Dir(DefaultConversationsDir()), "plans", "old-legacy-plan.md")
	writeTestFile(t, legacyPlan, "legacy plan v1")
	spill := filepath.Join(ToolResultsDir(source.ID), "result-1.txt")
	writeTestFile(t, spill, "full tool output")

	AppendEntry(source, EntryPlanMarker, PlanMarkerData{Operation: "created", PlanFilePath: legacyPlan, PlanSlug: "old-legacy-plan"})
	AppendEntry(source, EntryPlanMarker, PlanMarkerData{Operation: "created", PlanFilePath: ownedPlan, PlanSlug: "calm-jumping-fox"})
	AddUserMessage(source, "[Attached plan: "+legacyPlan+"]\n\nimplement it")
	AddUserMessage(source, "output was saved.\nFull output saved to: "+spill+" — use Read")

	return forkFixture{source: source, forked: ForkConversation(source, 10), ownedPlan: ownedPlan, legacyPlan: legacyPlan, spill: spill}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readTestFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// Editing the fork's plan must never change the source's. Before forks owned
// their files, the fork's session held the source's plan path, so this edit
// landed in the source's plan.
func TestCopyOwnedFilesForFork_ForkPlanIsIndependent(t *testing.T) {
	f := newForkFixture(t)
	result, err := CopyOwnedFilesForFork(f.source, f.forked, f.ownedPlan, nil)
	if err != nil {
		t.Fatalf("CopyOwnedFilesForFork: %v", err)
	}
	want := filepath.Join(PlansDir(f.forked.ID), "calm-jumping-fox.md")
	if result.PlanFilePath != want {
		t.Fatalf("fork plan = %q, want %q", result.PlanFilePath, want)
	}
	writeTestFile(t, result.PlanFilePath, "fork edited the plan")
	if got := readTestFile(t, f.ownedPlan); got != "owned plan v1" {
		t.Fatalf("source plan changed to %q after the fork edited its own", got)
	}
}

// Every path the fork's history names points at the fork's own copy, and the
// source's history is untouched.
func TestCopyOwnedFilesForFork_RewritesEveryPath(t *testing.T) {
	f := newForkFixture(t)
	if _, err := CopyOwnedFilesForFork(f.source, f.forked, f.ownedPlan, nil); err != nil {
		t.Fatalf("CopyOwnedFilesForFork: %v", err)
	}
	if err := Save(f.forked, ""); err != nil {
		t.Fatalf("save fork: %v", err)
	}
	for _, suffix := range []string{".tree.jsonl", ".llm.jsonl"} {
		body := readTestFile(t, filepath.Join(DefaultConversationsDir(), f.forked.ID+suffix))
		for _, old := range []string{f.ownedPlan, f.legacyPlan, f.spill} {
			if strings.Contains(body, old) {
				t.Errorf("%s still names the source's %s", suffix, old)
			}
		}
		if !strings.Contains(body, OwnedDir(f.forked.ID)) && suffix == ".tree.jsonl" {
			t.Errorf("%s names nothing in the fork's folder", suffix)
		}
	}
	if !strings.Contains(readTestFile(t, filepath.Join(ToolResultsDir(f.forked.ID), "result-1.txt")), "full tool output") {
		t.Error("tool result was not shared into the fork")
	}
	// The source's entries were shared by value with the fork; replacing the
	// fork's must not reach back into the source.
	for _, e := range f.source.Entries {
		if pd := asPlanMarkerData(e.Data); pd != nil && strings.Contains(pd.PlanFilePath, f.forked.ID) {
			t.Fatalf("source plan marker was rewritten: %s", pd.PlanFilePath)
		}
	}
	legacyCopy := filepath.Join(PlansDir(f.forked.ID), "old-legacy-plan.md")
	if got := readTestFile(t, legacyCopy); got != "legacy plan v1" {
		t.Fatalf("legacy plan copy = %q", got)
	}
}

// A claude-code plan lives in the project, because the CLI cannot write
// anywhere else. The fork's copy goes beside it under a fresh slug.
func TestCopyOwnedFilesForFork_ProjectPlanGetsItsOwnSlug(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	project := t.TempDir()
	plan := filepath.Join(project, ".ion", "plans", "brave-running-owl.md")
	writeTestFile(t, plan, "project plan")
	source := CreateConversation("src-cc", "system", "model")
	AppendEntry(source, EntryPlanMarker, PlanMarkerData{Operation: "created", PlanFilePath: plan, PlanSlug: "brave-running-owl"})
	forked := ForkConversation(source, 10)

	fresh := filepath.Join(project, ".ion", "plans", "new-fresh-slug.md")
	result, err := CopyOwnedFilesForFork(source, forked, plan, func(dir string) string { return filepath.Join(dir, "new-fresh-slug.md") })
	if err != nil {
		t.Fatalf("CopyOwnedFilesForFork: %v", err)
	}
	if result.PlanFilePath != fresh {
		t.Fatalf("fork plan = %q, want %q", result.PlanFilePath, fresh)
	}
	if len(result.ProjectCopies) != 1 || result.ProjectCopies[0] != fresh {
		t.Fatalf("project copies = %v", result.ProjectCopies)
	}
	RemoveForkFiles(forked.ID, result)
	if _, err := os.Stat(fresh); !os.IsNotExist(err) {
		t.Fatal("RemoveForkFiles left the project plan copy")
	}
	if got := readTestFile(t, plan); got != "project plan" {
		t.Fatalf("source project plan changed: %q", got)
	}
}

func TestForkOf_SetOnForkOnlyAndPersisted(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	source := CreateConversation("src-forkof", "system", "model")
	AddUserMessage(source, "hi")
	forked := ForkConversation(source, 0)
	if forked.ForkOf != source.ID || forked.ParentID != source.ID {
		t.Fatalf("fork ForkOf=%q ParentID=%q", forked.ForkOf, forked.ParentID)
	}
	if err := Save(forked, ""); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(forked.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ForkOf != source.ID {
		t.Fatalf("ForkOf did not survive save/load: %q", loaded.ForkOf)
	}

	child := CreateConversation("dispatch-child", "system", "model")
	child.ParentID = source.ID
	AddUserMessage(child, "task")
	if err := Save(child, ""); err != nil {
		t.Fatal(err)
	}
	header := readTestFile(t, filepath.Join(DefaultConversationsDir(), child.ID+".llm.jsonl"))
	if strings.Contains(header, `"forkOf"`) {
		t.Fatal("a dispatch child must not be marked as a fork")
	}
}

func TestIsOwnedPlanPath(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	root := DefaultConversationsDir()
	cases := map[string]bool{
		filepath.Join(root, "abc", "plans", "x.md"):                    true,
		filepath.Join(root, "partition", "abc", "plans", "x.md"):       true,
		filepath.Join(root, "tool-results", "plans", "x.md"):           false,
		filepath.Join(root, "abc", "images", "x.md"):                   false,
		filepath.Join(filepath.Dir(root), "plans", "x.md"):             false,
		filepath.Join(t.TempDir(), "conversations", "a", "plans", "x"): false,
	}
	for path, want := range cases {
		if got := IsOwnedPlanPath(path); got != want {
			t.Errorf("IsOwnedPlanPath(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestRewriteJSONPaths_BoundaryAndLongestMatch(t *testing.T) {
	pairs := jsonPathPairs(
		map[string]string{`/a/plan.md`: `/b/plan.md`, `C:\p\x.md`: `D:\q\x.md`},
		map[string]string{`/a/dir/`: `/z/dir/`},
	)
	in := []byte(`{"p":"/a/plan.md","q":"/a/plan.md.bak","r":"/a/dir/f.txt","w":"C:\\p\\x.md"}`)
	got := string(RewriteJSONPaths(in, pairs))
	want := `{"p":"/b/plan.md","q":"/a/plan.md.bak","r":"/z/dir/f.txt","w":"D:\\q\\x.md"}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}
