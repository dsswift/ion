package backend

import (
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Ordering for tool calls in one response that touch the same file.
//
// Tool calls in a single assistant response run concurrently, which is the
// whole point: independent reads and searches should not queue behind each
// other. But a model that batches `Edit(f)` and `Read(f)` together is asking
// two questions whose answers depend on each other, and a race decides which
// it gets. When the Read wins, it returns pre-edit content — and the write
// landed correctly, so the file on disk disagrees with what the model was just
// told.
//
// That failure mode is not theoretical. It was reported three separate times
// from a Windows endpoint as "Read returns stale content after Edit", each
// time diagnosed as a caching bug in Read. Read has no cache: it calls
// os.ReadFile on every invocation, and Edit writes through an fsync-then-
// rename. The conversation transcript showed the Edit and the Read carrying
// the same assistant-block timestamp on every reported occurrence — they were
// siblings, executed in parallel, and the ordering was never guaranteed.
//
// Documenting it was not enough. The tool description was updated to warn
// against batching a read with a write of the same file; the very next
// diagnostic run, against a build carrying that warning, batched them four
// more times and reported the bug again. A contract a caller cannot see the
// consequences of violating is a contract the engine has to enforce itself.
//
// So the engine orders them. Within one response, calls whose targets overlap
// are executed in the order the model listed them, and everything else still
// runs concurrently. A model that writes then reads gets the write it just
// made; a model that batches ten unrelated reads pays nothing.
//
// "Overlap" is containment, not equality. The same race reappeared with a
// different pair: `Write(C:\Users\josh\f.txt)` batched with
// `Grep(path: C:\Users\josh)`. The search walked the directory while the
// write was still in flight and missed a file that existed by the time the
// result was read — reported as a stale index, though the walk holds no index
// at all. A search rooted at a directory therefore serializes against a write
// to any file beneath it.

// fileTouchingTools are the tools whose input names a single file path that
// the call either reads or modifies.
//
// Bash is deliberately absent. A shell command can touch any path, and
// deducing which from a command string is guesswork that would either
// serialize everything or miss the case it was added for. The rule covers the
// tools whose target is declared in their input, which is where the reported
// failure lives.
var fileTouchingTools = map[string]bool{
	"Read":         true,
	"Write":        true,
	"Edit":         true,
	"NotebookEdit": true,
}

// searchingTools walk a tree rather than naming one file, so their target is a
// directory that may CONTAIN another call's file. Their root is optional: an
// absent path means "search cwd", which contains everything relative.
var searchingTools = map[string]bool{
	"Grep": true,
	"Glob": true,
}

// fileConflictGroups partitions tool-call indices into groups that must run
// sequentially, returning one group per contended file path.
//
// A path with a single call in the response is not returned: it has nothing to
// serialize against and belongs in the concurrent set.
func fileConflictGroups(blocks []types.LlmContentBlock) map[string][]int {
	// Each call's declared target: a file for the file tools, a directory root
	// for the searching tools. cwdRoot stands in for an omitted search path.
	type target struct {
		index    int
		path     string
		isSearch bool
	}
	var targets []target
	for i, block := range blocks {
		if block.Type != "tool_use" {
			continue
		}
		switch {
		case fileTouchingTools[block.Name]:
			if p := normalizeToolPath(stringField(block.Input, "file_path")); p != "" {
				targets = append(targets, target{index: i, path: p})
			}
		case searchingTools[block.Name]:
			// An omitted path means cwd, which contains every relative target
			// in the response — so it must still participate.
			p := normalizeToolPath(stringField(block.Input, "path"))
			if p == "" {
				p = cwdRoot
			}
			targets = append(targets, target{index: i, path: p, isSearch: true})
		}
	}

	// Group by the FILE target, attaching every search whose root contains it.
	// Keying on the file keeps the group name meaningful in the log and keeps
	// two searches over unrelated trees from being joined through a common
	// ancestor they both merely sit under.
	byPath := map[string][]int{}
	for _, t := range targets {
		if t.isSearch {
			continue
		}
		idx := []int{t.index}
		for _, other := range targets {
			if other.index == t.index {
				continue
			}
			if other.path == t.path || (other.isSearch && searchRootContains(other.path, t.path)) {
				idx = append(idx, other.index)
			}
		}
		if len(idx) < 2 {
			continue
		}
		sort.Ints(idx)
		byPath[t.path] = idx
	}
	return byPath
}

// cwdRoot marks a search with no explicit path. It is not a real path — the
// grouping never resolves it — only a token meaning "contains everything".
const cwdRoot = "\x00cwd"

// searchRootContains reports whether a search rooted at root would walk file.
//
// cwdRoot contains everything, since a search of the working directory reaches
// any relative target in the same response. Otherwise this is a prefix test on
// already-normalized paths, with a separator boundary so /a/bc is not treated
// as living under /a/b.
func searchRootContains(root, file string) bool {
	if root == cwdRoot {
		return true
	}
	if root == file {
		return true
	}
	return strings.HasPrefix(file, root+"/")
}

// stringField reads a string out of a tool input map, returning "" when the
// key is absent or the wrong type. An absent key is meaningful for a search
// tool (it means cwd), so this never reports an error.
func stringField(input map[string]any, key string) string {
	v, ok := input[key].(string)
	if !ok {
		return ""
	}
	return v
}

// normalizeToolPath canonicalizes a declared path enough to compare two
// spellings of one target.
//
// Case is folded because the reported failures are on Windows, whose
// filesystem is case-insensitive, and separators are unified so `dir/f` and
// `dir\f` compare equal. Deliberately NOT resolved to an absolute path: that
// would need the cwd and a stat, and a false grouping costs only a little
// serialization while a missed one costs the bug this exists to prevent.
func normalizeToolPath(raw string) string {
	if raw == "" {
		return ""
	}
	unified := strings.ReplaceAll(raw, "\\", "/")
	return strings.ToLower(strings.TrimRight(unified, "/"))
}

// logFileConflictOrdering records what was serialized and why.
//
// A tool call that ran later than the model expected is invisible without
// this: the results come back in the same order either way, so the only
// evidence that ordering was applied is a log line. Emitted at INFO, not
// debug, because "why did these two not run in parallel" is a question asked
// about a live session.
func logFileConflictOrdering(groups map[string][]int, blocks []types.LlmContentBlock) {
	for path, idx := range groups {
		names := make([]string, 0, len(idx))
		for _, i := range idx {
			names = append(names, blocks[i].Name)
		}
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "serialized tool calls that touch one file", map[string]any{
			"path":  path,
			"tools": strings.Join(names, ","),
			"count": len(idx),
		})
	}
}
