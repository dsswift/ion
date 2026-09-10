package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func toolUse(name, path string) types.LlmContentBlock {
	in := map[string]any{}
	if path != "" {
		in["file_path"] = path
	}
	return types.LlmContentBlock{Type: "tool_use", Name: name, Input: in}
}

// The reported failure: a model batches Edit(f) and Read(f) in one response,
// they run in parallel, and the Read can win — returning pre-edit content while
// the write landed correctly. Grouping them is what removes the race.
func TestFileConflictGroupsPairsAnEditAndReadOfOneFile(t *testing.T) {
	blocks := []types.LlmContentBlock{
		toolUse("Edit", `C:\Users\josh\note.txt`),
		toolUse("Read", `C:\Users\josh\note.txt`),
	}

	groups := fileConflictGroups(blocks)
	if len(groups) != 1 {
		t.Fatalf("group count = %d, want 1: %v", len(groups), groups)
	}
	for _, idx := range groups {
		if len(idx) != 2 {
			t.Fatalf("group size = %d, want 2", len(idx))
		}
		// Order must be the order the model listed them, or serializing would
		// still be free to run the Read first.
		if idx[0] != 0 || idx[1] != 1 {
			t.Errorf("group order = %v, want [0 1] (the order listed)", idx)
		}
	}
}

// Serializing everything would make the parallel tool loop pointless. Only
// contended targets are grouped.
//
// Note the Grep here carries an explicit unrelated root. A Grep with NO path
// means cwd, which contains both reads, and is expected to group with them --
// covered by TestFileConflictGroupsPairsAWriteWithAPathlessSearch.
func TestFileConflictGroupsLeavesIndependentCallsAlone(t *testing.T) {
	blocks := []types.LlmContentBlock{
		toolUse("Read", "/a.txt"),
		toolUse("Read", "/b.txt"),
		{Type: "tool_use", Name: "Grep", Input: map[string]any{
			"pattern": "x", "path": "/elsewhere",
		}},
	}

	if groups := fileConflictGroups(blocks); len(groups) != 0 {
		t.Errorf("independent calls were grouped: %v", groups)
	}
}

// A single call on a path has nothing to serialize against.
func TestFileConflictGroupsIgnoresASingleTouch(t *testing.T) {
	blocks := []types.LlmContentBlock{toolUse("Edit", "/only.txt")}

	if groups := fileConflictGroups(blocks); len(groups) != 0 {
		t.Errorf("a lone call was grouped: %v", groups)
	}
}

// Windows is where this was reported, and its filesystem is case-insensitive:
// two spellings of one file must land in one group or the race survives.
func TestFileConflictGroupsFoldsWindowsPathSpellings(t *testing.T) {
	blocks := []types.LlmContentBlock{
		toolUse("Write", `C:\Users\Josh\Note.txt`),
		toolUse("Read", `c:/users/josh/note.txt`),
	}

	groups := fileConflictGroups(blocks)
	if len(groups) != 1 {
		t.Errorf("case and separator variants were not grouped: %v", groups)
	}
}

// Three or more calls on one file keep their listed order throughout.
func TestFileConflictGroupsPreservesOrderAcrossManyTouches(t *testing.T) {
	blocks := []types.LlmContentBlock{
		toolUse("Write", "/f.txt"),
		toolUse("Read", "/other.txt"),
		toolUse("Edit", "/f.txt"),
		toolUse("Read", "/f.txt"),
	}

	groups := fileConflictGroups(blocks)
	idx, ok := groups["/f.txt"]
	if !ok {
		t.Fatalf("contended file not grouped: %v", groups)
	}
	want := []int{0, 2, 3}
	if len(idx) != len(want) {
		t.Fatalf("group = %v, want %v", idx, want)
	}
	for i := range want {
		if idx[i] != want[i] {
			t.Fatalf("group = %v, want %v", idx, want)
		}
	}
}

// Bash is deliberately excluded: a shell command can touch any path, and
// guessing which from a command string would either serialize everything or
// miss the case this exists for.
func TestFileConflictGroupsIgnoresBash(t *testing.T) {
	blocks := []types.LlmContentBlock{
		toolUse("Edit", "/f.txt"),
		{Type: "tool_use", Name: "Bash", Input: map[string]any{"command": "cat /f.txt"}},
	}

	if groups := fileConflictGroups(blocks); len(groups) != 0 {
		t.Errorf("Bash was treated as a file toucher: %v", groups)
	}
}

// A tool_use block with no file_path (Grep, TodoWrite) must not group under an
// empty key.
func TestFileConflictGroupsIgnoresCallsWithoutAPath(t *testing.T) {
	blocks := []types.LlmContentBlock{
		toolUse("Read", ""),
		toolUse("Write", ""),
	}

	if groups := fileConflictGroups(blocks); len(groups) != 0 {
		t.Errorf("pathless calls were grouped: %v", groups)
	}
}

// Only tool_use blocks are considered; text blocks share the response.
func TestFileConflictGroupsIgnoresNonToolBlocks(t *testing.T) {
	blocks := []types.LlmContentBlock{
		{Type: "text", Text: "editing the file now"},
		toolUse("Edit", "/f.txt"),
		toolUse("Read", "/f.txt"),
	}

	groups := fileConflictGroups(blocks)
	idx, ok := groups["/f.txt"]
	if !ok || len(idx) != 2 || idx[0] != 1 || idx[1] != 2 {
		t.Errorf("group = %v, want indices [1 2]", groups)
	}
}

// Round 5 surfaced the same race with a different pair: Write(f) batched with
// Grep(path: the directory holding f). The walk ran while the write was in
// flight and missed a file that existed by the time the result was read --
// reported as a stale index, though the walk keeps no index.
func TestFileConflictGroupsPairsAWriteWithASearchOfItsDirectory(t *testing.T) {
	blocks := []types.LlmContentBlock{
		toolUse("Write", `C:\Users\josh\note.txt`),
		{Type: "tool_use", Name: "Grep", Input: map[string]any{
			"pattern": "needle", "path": `C:\Users\josh`,
		}},
	}

	groups := fileConflictGroups(blocks)
	idx, ok := groups[`c:/users/josh/note.txt`]
	if !ok {
		t.Fatalf("a write and a search of its directory were not grouped: %v", groups)
	}
	if len(idx) != 2 || idx[0] != 0 || idx[1] != 1 {
		t.Errorf("group = %v, want [0 1] in listed order", idx)
	}
}

// A search with no path means cwd, which contains every relative target in the
// same response -- so it must still serialize against a write.
func TestFileConflictGroupsPairsAWriteWithAPathlessSearch(t *testing.T) {
	blocks := []types.LlmContentBlock{
		toolUse("Write", "notes/f.txt"),
		{Type: "tool_use", Name: "Glob", Input: map[string]any{"pattern": "**/*.txt"}},
	}

	if groups := fileConflictGroups(blocks); len(groups) != 1 {
		t.Errorf("a pathless search was not grouped with a write: %v", groups)
	}
}

// A search of an unrelated tree must stay concurrent, or every batch with a
// Grep in it serializes.
func TestFileConflictGroupsLeavesAnUnrelatedSearchConcurrent(t *testing.T) {
	blocks := []types.LlmContentBlock{
		toolUse("Write", `C:\Users\josh\note.txt`),
		{Type: "tool_use", Name: "Grep", Input: map[string]any{
			"pattern": "needle", "path": `C:\dev\ion`,
		}},
	}

	if groups := fileConflictGroups(blocks); len(groups) != 0 {
		t.Errorf("a search of an unrelated tree was serialized: %v", groups)
	}
}

// Prefix matching must respect the separator boundary: /a/bc does not live
// under /a/b.
func TestFileConflictGroupsRespectsPathBoundaries(t *testing.T) {
	blocks := []types.LlmContentBlock{
		toolUse("Write", "/a/bc/f.txt"),
		{Type: "tool_use", Name: "Grep", Input: map[string]any{
			"pattern": "x", "path": "/a/b",
		}},
	}

	if groups := fileConflictGroups(blocks); len(groups) != 0 {
		t.Errorf("a sibling directory was treated as a parent: %v", groups)
	}
}

// A read is as exposed to the race as a write: a search batched with a read of
// a file under its root should still order deterministically.
func TestFileConflictGroupsPairsASearchWithAReadBeneathIt(t *testing.T) {
	blocks := []types.LlmContentBlock{
		{Type: "tool_use", Name: "Grep", Input: map[string]any{
			"pattern": "x", "path": "/proj",
		}},
		toolUse("Read", "/proj/sub/f.txt"),
	}

	groups := fileConflictGroups(blocks)
	idx, ok := groups["/proj/sub/f.txt"]
	if !ok {
		t.Fatalf("a search and a read beneath it were not grouped: %v", groups)
	}
	if idx[0] != 0 || idx[1] != 1 {
		t.Errorf("group = %v, want the listed order [0 1]", idx)
	}
}

// Two searches over unrelated trees must not be joined merely because both sit
// under some common ancestor -- the grouping keys on the FILE target, so with
// no file in the response there is nothing to group.
func TestFileConflictGroupsIgnoresSearchesWithNoFileTarget(t *testing.T) {
	blocks := []types.LlmContentBlock{
		{Type: "tool_use", Name: "Grep", Input: map[string]any{"pattern": "a", "path": "/x"}},
		{Type: "tool_use", Name: "Grep", Input: map[string]any{"pattern": "b", "path": "/y"}},
	}

	if groups := fileConflictGroups(blocks); len(groups) != 0 {
		t.Errorf("two searches were grouped with no file between them: %v", groups)
	}
}
