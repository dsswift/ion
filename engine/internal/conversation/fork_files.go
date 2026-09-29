package conversation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ForkFilesResult reports what CopyOwnedFilesForFork did.
type ForkFilesResult struct {
	// PlanFilePath is the fork's own copy of the plan the source session had
	// open, or "" when the source had none.
	PlanFilePath string
	// CopiedFiles counts files copied (plans, attachments).
	CopiedFiles int
	// LinkedFiles counts spilled tool results shared by hard link.
	LinkedFiles int
	// RewrittenEntries counts tree entries whose paths now point at the fork.
	RewrittenEntries int
	// MissingPlans lists plan paths the history names that no longer exist.
	MissingPlans []string
	// ProjectCopies lists plan copies written outside the fork's own folder
	// (a claude-code project plan's new slug). Deleting the fork's folder does
	// not remove these, so RemoveForkFiles does.
	ProjectCopies []string
}

// RemoveForkFiles undoes CopyOwnedFilesForFork for a fork that failed to
// save or start: its own folder, its tool results, and any project plan copy.
func RemoveForkFiles(forkID string, result ForkFilesResult) {
	os.RemoveAll(OwnedDir(forkID))       //nolint:errcheck // rollback of a fork that never became visible
	os.RemoveAll(ToolResultsDir(forkID)) //nolint:errcheck // rollback of a fork that never became visible
	for _, p := range result.ProjectCopies {
		os.Remove(p) //nolint:errcheck // rollback of a project plan copy
	}
	utils.LogWithFields(utils.LevelInfo, "conversation.fork_files", "fork files removed after a failed fork", map[string]any{"conversation_id": forkID, "project_copies": len(result.ProjectCopies)})
}

// ProjectPlanPath mints a fresh plan path in dir. The session package owns
// plan-slug generation, so it passes its generator in.
type ProjectPlanPath func(dir string) string

// CopyOwnedFilesForFork gives forked its own copy of every file source's
// history points at, so the two conversations can change independently from
// here on:
//
//   - `<source>/plans/` and `<source>/attachments/` are copied into the fork's
//     folder. Plans are edited in place, so sharing one would let a fork's
//     edits show up in the original.
//   - A plan the history names outside source's own folder (the legacy shared
//     `<IonDir>/plans`, or a claude-code plan under the project's
//     `.ion/plans`) is copied too: into the fork's plans folder, or, for a
//     project plan, beside the original under a fresh slug, because the
//     claude-code CLI can only write plans inside the project.
//   - `tool-results/<source>/` is hard-linked into `tool-results/<fork>/`.
//     Those files are written once and never changed, so the bytes can be
//     shared safely, and either side can be deleted without the other.
//
// Every path in forked's entries (and messages) that named one of those files
// is then rewritten to the fork's copy. forked must not be visible to anyone
// else yet: this runs between building the fork and saving it. planFilePath
// is the source session's current plan; the fork's own copy of it is
// returned. On error, whatever was copied is removed.
func CopyOwnedFilesForFork(source, forked *Conversation, planFilePath string, projectPlanPath ProjectPlanPath) (ForkFilesResult, error) {
	var result ForkFilesResult
	fields := map[string]any{"source_conversation_id": source.ID, "conversation_id": forked.ID}
	srcOwned := OwnedDir(source.ID)
	dstOwned := OwnedDir(forked.ID)
	dstToolResults := ToolResultsDir(forked.ID)

	files := map[string]string{}
	dirs := map[string]string{}
	fail := func(step string, err error) (ForkFilesResult, error) {
		os.RemoveAll(dstOwned)       //nolint:errcheck // rollback of a fork that never became visible
		os.RemoveAll(dstToolResults) //nolint:errcheck // rollback of a fork that never became visible
		for _, dst := range files {
			if !isWithin(dstOwned, dst) {
				os.Remove(dst) //nolint:errcheck // rollback of a project plan copy
			}
		}
		utils.LogWithFields(utils.LevelError, "conversation.fork_files", "fork files failed; copies removed", mergeFields(fields, map[string]any{"step": step, "error": err.Error()}))
		return ForkFilesResult{}, fmt.Errorf("fork files: %s: %w", step, err)
	}

	for _, sub := range []string{"plans", "attachments"} {
		src := filepath.Join(srcOwned, sub)
		n, err := copyTree(src, filepath.Join(dstOwned, sub), false)
		if err != nil {
			return fail("copy "+sub, err)
		}
		if n > 0 {
			dirs[src+string(filepath.Separator)] = filepath.Join(dstOwned, sub) + string(filepath.Separator)
			result.CopiedFiles += n
		}
	}

	srcToolResults := ToolResultsDir(source.ID)
	linked, err := copyTree(srcToolResults, dstToolResults, true)
	if err != nil {
		return fail("link tool results", err)
	}
	if linked > 0 {
		dirs[srcToolResults+string(filepath.Separator)] = dstToolResults + string(filepath.Separator)
		result.LinkedFiles = linked
	}

	// Plans kept outside the source's own folder.
	for _, plan := range planPathsIn(forked, planFilePath) {
		if isWithin(srcOwned, plan) {
			continue
		}
		if _, err := os.Stat(plan); err != nil {
			result.MissingPlans = append(result.MissingPlans, plan)
			utils.LogWithFields(utils.LevelWarn, "conversation.fork_files", "plan named in history is missing; left as is", mergeFields(fields, map[string]any{"path": plan}))
			continue
		}
		dst := ownedPlanDestination(plan, forked.ID, projectPlanPath)
		if err := copyFile(plan, dst); err != nil {
			return fail("copy shared plan", err)
		}
		files[plan] = dst
		result.CopiedFiles++
		if !isWithin(dstOwned, dst) {
			result.ProjectCopies = append(result.ProjectCopies, dst)
		}
	}

	rewritten, err := RewriteConversationPaths(forked, files, dirs)
	if err != nil {
		return fail("rewrite paths", err)
	}
	result.RewrittenEntries = rewritten
	if planFilePath != "" {
		result.PlanFilePath = MapPath(planFilePath, files, dirs)
	}
	utils.LogWithFields(utils.LevelInfo, "conversation.fork_files", "fork owns its files", mergeFields(fields, map[string]any{
		"copied": result.CopiedFiles, "linked": result.LinkedFiles, "rewritten": result.RewrittenEntries,
		"missing": len(result.MissingPlans), "plan_file_path": result.PlanFilePath,
	}))
	return result, nil
}

// ownedPlanDestination picks where a fork's copy of a plan kept outside the
// source's folder goes. A claude-code project plan (`<project>/.ion/plans`)
// stays in that folder under a fresh slug; any other plan moves into the
// fork's own plans folder under its own name.
func ownedPlanDestination(plan, forkID string, projectPlanPath ProjectPlanPath) string {
	dir := filepath.Dir(plan)
	legacy := filepath.Join(utils.IonDir(), "plans")
	if projectPlanPath != nil && !IsOwnedPlanPath(plan) && filepath.Clean(dir) != filepath.Clean(legacy) &&
		filepath.Base(dir) == "plans" && filepath.Base(filepath.Dir(dir)) == ".ion" {
		return projectPlanPath(dir)
	}
	return filepath.Join(PlansDir(forkID), filepath.Base(plan))
}

// planPathsIn lists every plan file forked's history names, plus current,
// without duplicates.
func planPathsIn(conv *Conversation, current string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(p string) {
		if p == "" || seen[p] {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	add(current)
	for _, e := range conv.Entries {
		if e.Type != EntryPlanMarker {
			continue
		}
		if pd := asPlanMarkerData(e.Data); pd != nil {
			add(pd.PlanFilePath)
		}
	}
	return out
}

// MapPath returns path's new location under files (exact) or dirs (prefix,
// keys ending in a separator), or path itself when neither names it.
func MapPath(path string, files, dirs map[string]string) string {
	if dst, ok := files[path]; ok {
		return dst
	}
	best := ""
	for src := range dirs {
		if strings.HasPrefix(path, src) && len(src) > len(best) {
			best = src
		}
	}
	if best != "" {
		return dirs[best] + path[len(best):]
	}
	return path
}

// RewriteConversationPaths rewrites every occurrence of a mapped path in
// conv's entries and messages. files maps exact file paths; dirs maps
// directory prefixes that end in a separator. Paths are matched in their
// JSON-escaped form so a Windows path's backslashes match as stored, a file
// path matches only when the next character cannot continue a file name,
// and the longest match wins. Only entries that contain a path are replaced;
// every other entry keeps its value. Returns how many entries changed.
func RewriteConversationPaths(conv *Conversation, files, dirs map[string]string) (int, error) {
	pairs := jsonPathPairs(files, dirs)
	if len(pairs) == 0 {
		return 0, nil
	}
	changed := 0
	for i := range conv.Entries {
		raw, err := json.Marshal(conv.Entries[i].Data)
		if err != nil {
			return changed, fmt.Errorf("marshal entry %s: %w", conv.Entries[i].ID, err)
		}
		next := RewriteJSONPaths(raw, pairs)
		if bytes.Equal(next, raw) {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(next, &data); err != nil {
			return changed, fmt.Errorf("unmarshal rewritten entry %s: %w", conv.Entries[i].ID, err)
		}
		conv.Entries[i].Data = data
		changed++
	}
	if changed > 0 {
		if err := rehydrateEntries(conv); err != nil {
			return changed, fmt.Errorf("rehydrate rewritten entries: %w", err)
		}
	}
	if len(conv.Entries) > 0 {
		if changed == 0 {
			return 0, nil
		}
		conv.lock()
		conv.Messages = buildContextPathLocked(conv)
		conv.unlock()
		return changed, nil
	}
	raw, err := json.Marshal(conv.Messages)
	if err != nil {
		return changed, fmt.Errorf("marshal messages: %w", err)
	}
	next := RewriteJSONPaths(raw, pairs)
	if !bytes.Equal(next, raw) {
		var msgs []types.LlmMessage
		if err := json.Unmarshal(next, &msgs); err != nil {
			return changed, fmt.Errorf("unmarshal rewritten messages: %w", err)
		}
		conv.Messages = msgs
	}
	return changed, nil
}

// PathPair is one JSON-escaped path rewrite.
type PathPair struct {
	From, To []byte
	// Dir is true for a directory prefix, which needs no name boundary.
	Dir bool
}

func jsonPathPairs(files, dirs map[string]string) []PathPair {
	var pairs []PathPair
	for from, to := range files {
		pairs = append(pairs, PathPair{From: jsonEscaped(from), To: jsonEscaped(to)})
	}
	for from, to := range dirs {
		pairs = append(pairs, PathPair{From: jsonEscaped(from), To: jsonEscaped(to), Dir: true})
	}
	sort.Slice(pairs, func(i, j int) bool { return len(pairs[i].From) > len(pairs[j].From) })
	return pairs
}

func jsonEscaped(s string) []byte {
	b, _ := json.Marshal(s) //nolint:errcheck // marshaling a string cannot fail
	return b[1 : len(b)-1]
}

// RewriteJSONPaths applies pairs (longest first) to raw in one left-to-right
// pass, so a replacement is never itself rewritten.
func RewriteJSONPaths(raw []byte, pairs []PathPair) []byte {
	var out bytes.Buffer
	i := 0
	for i < len(raw) {
		matched := false
		for _, p := range pairs {
			if !bytes.HasPrefix(raw[i:], p.From) {
				continue
			}
			end := i + len(p.From)
			if !p.Dir && end < len(raw) && continuesName(raw[end]) {
				continue
			}
			out.Write(p.To)
			i = end
			matched = true
			break
		}
		if !matched {
			out.WriteByte(raw[i])
			i++
		}
	}
	return out.Bytes()
}

// continuesName reports whether b could be the next character of a file
// name, in which case a file-path match there is only a prefix of a longer
// name and must not be rewritten.
func continuesName(b byte) bool {
	return b == '.' || b == '-' || b == '_' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// copyTree copies (or, with link, hard-links, falling back to a copy) every
// regular file under src into dst. A missing src copies nothing.
func copyTree(src, dst string, link bool) (int, error) {
	if _, err := os.Stat(src); errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	count := 0
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if link {
			if err := os.Link(path, target); err == nil {
				count++
				return nil
			}
		}
		if err := copyFile(path, target); err != nil {
			return err
		}
		count++
		return nil
	})
	return count, err
}

// copyFile copies src to dst, creating dst's folder. It refuses to replace
// a different file already at dst.
func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if same, err := sameContent(src, dst); err == nil && same {
		return nil
	} else if err == nil {
		return fmt.Errorf("a different file already exists at %s", dst)
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close() //nolint:errcheck // read-only handle
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()    //nolint:errcheck // already failing
		os.Remove(dst) //nolint:errcheck // partial copy cleanup
		return err
	}
	return out.Close()
}

// sameContent compares two files by digest. It errors when dst does not exist.
func sameContent(a, b string) (bool, error) {
	if _, err := os.Stat(b); err != nil {
		return false, err
	}
	da, err := fileDigest(a)
	if err != nil {
		return false, err
	}
	db, err := fileDigest(b)
	if err != nil {
		return false, err
	}
	return da == db, nil
}

func fileDigest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close() //nolint:errcheck // read-only handle
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func mergeFields(a, b map[string]any) map[string]any {
	out := make(map[string]any, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}
