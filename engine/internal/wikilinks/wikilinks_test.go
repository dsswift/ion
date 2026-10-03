package wikilinks

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// workspace writes files (root-relative path -> content) into a temp root.
func workspace(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, content := range files {
		write(t, root, rel, content)
	}
	return root
}

func write(t *testing.T, root, rel, content string) {
	t.Helper()
	abs := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// rename moves a file on disk the way the watcher would have observed it.
func rename(t *testing.T, root, oldRel, newRel string) types.WikiLinkRename {
	t.Helper()
	newAbs := filepath.Join(root, filepath.FromSlash(newRel))
	if err := os.MkdirAll(filepath.Dir(newAbs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, filepath.FromSlash(oldRel)), newAbs); err != nil {
		t.Fatal(err)
	}
	return types.WikiLinkRename{OldPath: oldRel, NewPath: newRel}
}

func opts(root string) Options {
	return Options{Root: root, Extensions: []string{".md"}}
}

func propagate(t *testing.T, root string, renames ...types.WikiLinkRename) types.WikiLinkPropagationReport {
	t.Helper()
	report, err := Propagate(opts(root), renames)
	if err != nil {
		t.Fatal(err)
	}
	return report
}

func TestParseLinks(t *testing.T) {
	doc := strings.Join([]string{
		"See [[alpha]] and [[beta|the label]].", // 1
		"Section [[gamma#Intro]] and [[ delta #Top|x]].",
		"Inline `[[not-a-link]]` stays.",
		"```",
		"[[ -f in-a-fence ]]",
		"```",
		"| [[epsilon\\|cell]] |",
		"Self [[#heading]] is skipped. ![[embedded]]",
		"$ grep 'metric[[:space:]]*{' and [[:alpha:]] are regex, [[:not a class:]] is a link.",
	}, "\n")

	type got struct {
		line           int
		target, suffix string
	}
	var have []got
	for _, l := range parseLinks([]byte(doc)) {
		have = append(have, got{l.line, l.target, l.suffix})
	}
	want := []got{
		{1, "alpha", ""},
		{1, "beta", "|the label"},
		{2, "gamma", "#Intro"},
		{2, "delta", "#Top|x"},
		{7, "epsilon", "\\|cell"},
		{8, "embedded", ""},
		{9, ":not a class:", ""},
	}
	if !reflect.DeepEqual(have, want) {
		t.Fatalf("links\n have %+v\n want %+v", have, want)
	}
}

func TestPropagateRewritesBareAndAliasedLinks(t *testing.T) {
	root := workspace(t, map[string]string{
		"old-name.md":    "# Old\n",
		"notes/a.md":     "Bare [[old-name]].\nAliased [[old-name|the old one]].\nSection [[old-name#Part|see part]].\n",
		"notes/b.md":     "Unrelated [[other]] and `[[old-name]]` in code.\n",
		"other.md":       "x\n",
		"notes/plain.md": "no links here\n",
	})
	r := rename(t, root, "old-name.md", "new-name.md")

	report := propagate(t, root, r)

	wantA := "Bare [[new-name]].\nAliased [[new-name|the old one]].\nSection [[new-name#Part|see part]].\n"
	if got := read(t, root, "notes/a.md"); got != wantA {
		t.Fatalf("notes/a.md = %q", got)
	}
	if got := read(t, root, "notes/b.md"); got != "Unrelated [[other]] and `[[old-name]]` in code.\n" {
		t.Fatalf("notes/b.md was touched: %q", got)
	}

	wantReport := []types.WikiLinkFileRewrites{{
		Path: "notes/a.md",
		Rewrites: []types.WikiLinkRewrite{
			{Line: 1, OldLink: "[[old-name]]", NewLink: "[[new-name]]", OldTarget: "old-name.md", NewTarget: "new-name.md"},
			{Line: 2, OldLink: "[[old-name|the old one]]", NewLink: "[[new-name|the old one]]", OldTarget: "old-name.md", NewTarget: "new-name.md"},
			{Line: 3, OldLink: "[[old-name#Part|see part]]", NewLink: "[[new-name#Part|see part]]", OldTarget: "old-name.md", NewTarget: "new-name.md"},
		},
	}}
	if !reflect.DeepEqual(report.Files, wantReport) {
		t.Fatalf("report files\n have %+v\n want %+v", report.Files, wantReport)
	}
	if report.RewriteCount != 3 || len(report.Failed) != 0 {
		t.Fatalf("rewriteCount=%d failed=%v", report.RewriteCount, report.Failed)
	}
	if !reflect.DeepEqual(report.Renames, []types.WikiLinkRename{r}) {
		t.Fatalf("renames = %+v", report.Renames)
	}
}

func TestPropagateKeepsLinkStyle(t *testing.T) {
	root := workspace(t, map[string]string{
		"docs/guide/target.md": "t\n",
		"docs/guide/peer.md":   "[[target]] [[./target]] [[target.md]]\n",
		"docs/index.md":        "[[guide/target]] [[docs/guide/target]] [[/docs/guide/target]]\n",
		"top.md":               "[[docs/guide/target|T]] [[target]]\n",
	})
	r := rename(t, root, "docs/guide/target.md", "docs/ref/renamed.md")

	propagate(t, root, r)

	cases := map[string]string{
		"docs/guide/peer.md": "[[renamed]] [[../ref/renamed]] [[renamed.md]]\n",
		"docs/index.md":      "[[ref/renamed]] [[docs/ref/renamed]] [[/docs/ref/renamed]]\n",
		"top.md":             "[[docs/ref/renamed|T]] [[renamed]]\n",
	}
	for rel, want := range cases {
		if got := read(t, root, rel); got != want {
			t.Errorf("%s = %q, want %q", rel, got, want)
		}
	}
}

func TestPropagateMoveWithoutNameChangeLeavesBareLinks(t *testing.T) {
	root := workspace(t, map[string]string{
		"a/note.md": "n\n",
		"index.md":  "[[note]] and [[a/note]]\n",
	})
	r := rename(t, root, "a/note.md", "b/note.md")

	report := propagate(t, root, r)

	if got := read(t, root, "index.md"); got != "[[note]] and [[b/note]]\n" {
		t.Fatalf("index.md = %q", got)
	}
	if report.RewriteCount != 1 {
		t.Fatalf("rewriteCount = %d, want 1", report.RewriteCount)
	}
}

func TestPropagateUsesPathWhenNewNameIsAmbiguous(t *testing.T) {
	root := workspace(t, map[string]string{
		"a/unique.md": "u\n",
		"b/shared.md": "s\n",
		"index.md":    "[[unique]]\n",
	})
	r := rename(t, root, "a/unique.md", "a/shared.md")

	propagate(t, root, r)

	if got := read(t, root, "index.md"); got != "[[a/shared]]\n" {
		t.Fatalf("index.md = %q", got)
	}
}

func TestPropagateLeavesAmbiguousLinksAlone(t *testing.T) {
	root := workspace(t, map[string]string{
		"a/dup.md": "1\n",
		"b/dup.md": "2\n",
		"index.md": "[[dup]]\n",
	})
	r := rename(t, root, "a/dup.md", "a/other.md")

	report := propagate(t, root, r)

	if got := read(t, root, "index.md"); got != "[[dup]]\n" {
		t.Fatalf("index.md = %q", got)
	}
	if report.RewriteCount != 0 {
		t.Fatalf("rewriteCount = %d, want 0", report.RewriteCount)
	}
}

func TestPropagateRepairsRelativeLinksInsideMovedFile(t *testing.T) {
	root := workspace(t, map[string]string{
		"a/mover.md":   "[[./sibling]] [[sibling]]\n",
		"a/sibling.md": "s\n",
		"b/sibling.md": "other\n",
	})
	r := rename(t, root, "a/mover.md", "b/mover.md")

	propagate(t, root, r)

	if got := read(t, root, "b/mover.md"); got != "[[../a/sibling]] [[a/sibling]]\n" {
		t.Fatalf("b/mover.md = %q", got)
	}
}

func TestPropagateBatchCollapsesChains(t *testing.T) {
	root := workspace(t, map[string]string{
		"one.md":   "1\n",
		"index.md": "[[one]]\n",
	})
	first := rename(t, root, "one.md", "two.md")
	second := rename(t, root, "two.md", "three.md")

	report := propagate(t, root, first, second)

	if got := read(t, root, "index.md"); got != "[[three]]\n" {
		t.Fatalf("index.md = %q", got)
	}
	if len(report.Renames) != 2 {
		t.Fatalf("renames = %+v", report.Renames)
	}
}

func TestPropagateIsConfinedToTheWorkspace(t *testing.T) {
	outside := workspace(t, map[string]string{"outside.md": "[[old]]\n"})
	root := workspace(t, map[string]string{
		"old.md":            "o\n",
		"inside.md":         "[[old]]\n",
		"vendor/ignored.md": "[[old]]\n",
	})
	link := filepath.Join(root, "linked.md")
	if err := os.Symlink(filepath.Join(outside, "outside.md"), link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked-dir")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	r := rename(t, root, "old.md", "new.md")

	o := opts(root)
	o.Ignore = func(rel string, isDir bool) bool { return rel == "vendor" || strings.HasPrefix(rel, "vendor/") }
	report, err := Propagate(o, []types.WikiLinkRename{r})
	if err != nil {
		t.Fatal(err)
	}

	if got := read(t, root, "inside.md"); got != "[[new]]\n" {
		t.Fatalf("inside.md = %q", got)
	}
	if got := read(t, outside, "outside.md"); got != "[[old]]\n" {
		t.Fatalf("file outside the workspace was rewritten: %q", got)
	}
	if got := read(t, root, "vendor/ignored.md"); got != "[[old]]\n" {
		t.Fatalf("ignored file was rewritten: %q", got)
	}
	if len(report.Files) != 1 || report.Files[0].Path != "inside.md" {
		t.Fatalf("report files = %+v", report.Files)
	}
	if st, err := os.Lstat(link); err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("symlink was replaced: %v %v", st, err)
	}
}

func TestPropagateKeepsFileModeAndLeavesNoTempFiles(t *testing.T) {
	root := workspace(t, map[string]string{"old.md": "o\n", "ref.md": "[[old]]\n"})
	if err := os.Chmod(filepath.Join(root, "ref.md"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := rename(t, root, "old.md", "new.md")

	propagate(t, root, r)

	st, err := os.Stat(filepath.Join(root, "ref.md"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", st.Mode().Perm())
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("unexpected entries left behind: %v", entries)
	}
}

func TestScanReportsBrokenLinks(t *testing.T) {
	root := workspace(t, map[string]string{
		"a/dup.md":    "1\n",
		"b/dup.md":    "2\n",
		"here.md":     "h\n",
		"img/pic.png": "png",
		"index.md": strings.Join([]string{
			"[[here]] [[img/pic.png]] [[pic.png]] [[#local]]",
			"[[gone]] and [[missing/path|label]]",
			"[[dup]]",
			"```",
			"[[ -f in-fence ]]",
			"```",
		}, "\n"),
	})
	before := read(t, root, "index.md")

	report, err := Scan(opts(root))
	if err != nil {
		t.Fatal(err)
	}

	want := []types.WikiLinkBrokenLink{
		{Path: "index.md", Line: 2, Link: "[[gone]]", Target: "gone", Reason: types.WikiLinkMissing},
		{Path: "index.md", Line: 2, Link: "[[missing/path|label]]", Target: "missing/path", Reason: types.WikiLinkMissing},
		{Path: "index.md", Line: 3, Link: "[[dup]]", Target: "dup", Reason: types.WikiLinkAmbiguous, Candidates: []string{"a/dup.md", "b/dup.md"}},
	}
	if !reflect.DeepEqual(report.Broken, want) {
		t.Fatalf("broken\n have %+v\n want %+v", report.Broken, want)
	}
	if report.DocumentsScanned != 4 || report.LinksChecked != 6 {
		t.Fatalf("documents=%d links=%d", report.DocumentsScanned, report.LinksChecked)
	}
	if read(t, root, "index.md") != before {
		t.Fatal("scan modified a file")
	}
}

func TestScanCleanCorpusReturnsEmptyList(t *testing.T) {
	root := workspace(t, map[string]string{"a.md": "[[b]]\n", "b.md": "plain\n"})
	report, err := Scan(opts(root))
	if err != nil {
		t.Fatal(err)
	}
	if report.Broken == nil || len(report.Broken) != 0 {
		t.Fatalf("broken = %#v, want empty non-nil", report.Broken)
	}
}
