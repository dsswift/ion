package wikilinks

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// maxRewriteAttempts bounds how often one file is re-read when something else
// writes to it between the read and the write.
const maxRewriteAttempts = 3

// errChangedUnderneath reports that a file kept changing between the read and
// the write, so the rewrite was abandoned rather than overwrite newer content.
var errChangedUnderneath = errors.New("file changed while its links were being rewritten")

// Propagate rewrites every wiki link whose meaning the given renames changed,
// so each link names the same file it named before. That covers links to a
// renamed file from anywhere in the workspace, and links inside a moved file
// whose relative targets no longer reach what they reached.
//
// renames are root-relative, forward-slash paths in the order they happened.
// The alias and `#section` of a rewritten link are kept as written. A link
// that named nothing before the renames is left alone.
//
// The returned report is complete for this pass. A file that could not be
// rewritten is listed in Failed; the pass continues past it.
func Propagate(opts Options, renames []types.WikiLinkRename) (types.WikiLinkPropagationReport, error) {
	report := types.WikiLinkPropagationReport{
		Renames: append([]types.WikiLinkRename{}, renames...),
		Files:   []types.WikiLinkFileRewrites{},
	}
	root, files, err := listFiles(opts)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "wikilinks", "propagate: listing workspace failed", map[string]any{"root": opts.Root, "error": err.Error()})
		return report, err
	}
	report.Root = root

	after := newCorpus(files, opts.Extensions)
	moved := effectiveRenames(renames, after)
	if len(moved) == 0 {
		utils.LogWithFields(utils.LevelInfo, "wikilinks", "propagate: no rename left to apply", map[string]any{"root": root, "renames": len(renames)})
		return report, nil
	}
	before := newCorpus(filesBefore(files, moved), opts.Extensions)
	oldOf := make(map[string]string, len(moved))
	for oldPath, newPath := range moved {
		oldOf[newPath] = oldPath
	}

	for _, rel := range files {
		if !opts.isDocument(rel) {
			continue
		}
		wasAt := rel
		if oldPath, ok := oldOf[rel]; ok {
			wasAt = oldPath
		}
		rewrites, err := rewriteFile(filepath.Join(root, filepath.FromSlash(rel)), func(content []byte) ([]byte, []types.WikiLinkRewrite) {
			return rewriteContent(content, before, after, moved, wasAt, rel)
		})
		if err != nil {
			utils.LogWithFields(utils.LevelError, "wikilinks", "propagate: rewrite failed", map[string]any{"root": root, "path": rel, "error": err.Error()})
			report.Failed = append(report.Failed, types.WikiLinkFileFailure{Path: rel, Error: err.Error()})
			continue
		}
		if len(rewrites) == 0 {
			continue
		}
		utils.LogWithFields(utils.LevelInfo, "wikilinks", "propagate: file rewritten", map[string]any{"root": root, "path": rel, "count": len(rewrites)})
		report.Files = append(report.Files, types.WikiLinkFileRewrites{Path: rel, Rewrites: rewrites})
		report.RewriteCount += len(rewrites)
	}

	utils.LogWithFields(utils.LevelInfo, "wikilinks", "propagate: done", map[string]any{
		"root": root, "renames": len(moved), "files": len(report.Files), "rewrites": report.RewriteCount, "failed": len(report.Failed),
	})
	return report, nil
}

// effectiveRenames collapses a sequence of renames into old-to-new pairs that
// describe the net move: a file renamed twice maps from its first name to its
// last. A rename whose destination is no longer in the workspace is dropped,
// as is one that ends where it began.
func effectiveRenames(renames []types.WikiLinkRename, after *corpus) map[string]string {
	moved := make(map[string]string, len(renames))
	originOf := make(map[string]string, len(renames))
	for _, r := range renames {
		origin := r.OldPath
		if earlier, ok := originOf[r.OldPath]; ok {
			origin = earlier
			delete(originOf, r.OldPath)
		}
		moved[origin] = r.NewPath
		originOf[r.NewPath] = origin
	}
	for oldPath, newPath := range moved {
		_, present := after.files[newPath]
		if oldPath == newPath || !present {
			utils.LogWithFields(utils.LevelDebug, "wikilinks", "propagate: rename dropped", map[string]any{"old": oldPath, "new": newPath, "destination_present": present})
			delete(moved, oldPath)
		}
	}
	return moved
}

// filesBefore reconstructs the file list as it stood before the renames.
func filesBefore(files []string, moved map[string]string) []string {
	isNew := make(map[string]bool, len(moved))
	for _, newPath := range moved {
		isNew[newPath] = true
	}
	present := make(map[string]bool, len(files))
	out := make([]string, 0, len(files))
	for _, rel := range files {
		if !isNew[rel] {
			out = append(out, rel)
			present[rel] = true
		}
	}
	for oldPath := range moved {
		// A file created at the old path since the rename is already listed.
		if !present[oldPath] {
			out = append(out, oldPath)
		}
	}
	return out
}

// rewriteContent returns content with every link the renames broke pointed
// back at the file it named. wasAt and isAt are the linking file's own path
// before and after the renames. Returns nil rewrites when nothing changed.
func rewriteContent(content []byte, before, after *corpus, moved map[string]string, wasAt, isAt string) ([]byte, []types.WikiLinkRewrite) {
	if !hasLinks(content) {
		return content, nil
	}
	var rewrites []types.WikiLinkRewrite
	var out strings.Builder
	last := 0
	for _, l := range parseLinks(content) {
		was := before.resolve(l.target, wasAt)
		if !was.resolved() {
			continue
		}
		want := was.path
		if newPath, ok := moved[was.path]; ok {
			want = newPath
		}
		if after.resolve(l.target, isAt).path == want {
			continue
		}
		target, ok := after.retarget(l.target, was.via, want, isAt)
		if !ok {
			utils.LogWithFields(utils.LevelWarn, "wikilinks", "propagate: no link form reaches the renamed file", map[string]any{"path": isAt, "line": l.line, "target": l.target, "want": want})
			continue
		}
		oldLink := string(content[l.start:l.end])
		newLink := l.text(target)
		out.Write(content[last:l.start])
		out.WriteString(newLink)
		last = l.end
		rewrites = append(rewrites, types.WikiLinkRewrite{
			Line: l.line, OldLink: oldLink, NewLink: newLink, OldTarget: was.path, NewTarget: want,
		})
	}
	if len(rewrites) == 0 {
		return content, nil
	}
	out.Write(content[last:])
	return []byte(out.String()), rewrites
}

// rewriteFile applies transform to the file at abs and replaces the file
// atomically when transform changed it. A file that something else writes
// between the read and the replace is read again, so newer content is never
// overwritten with a stale rewrite.
func rewriteFile(abs string, transform func([]byte) ([]byte, []types.WikiLinkRewrite)) ([]types.WikiLinkRewrite, error) {
	for attempt := 0; attempt < maxRewriteAttempts; attempt++ {
		st, err := os.Lstat(abs)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, nil
			}
			return nil, err
		}
		if !st.Mode().IsRegular() {
			return nil, nil
		}
		content, err := os.ReadFile(abs)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, nil
			}
			return nil, err
		}
		updated, rewrites := transform(content)
		if len(rewrites) == 0 {
			return nil, nil
		}
		replaced, err := replaceIfUnchanged(abs, st, updated)
		if err != nil {
			return nil, err
		}
		if replaced {
			return rewrites, nil
		}
		utils.LogWithFields(utils.LevelDebug, "wikilinks", "propagate: file changed during rewrite, retrying", map[string]any{"path": abs, "attempt": attempt + 1})
	}
	return nil, errChangedUnderneath
}

// replaceIfUnchanged writes content to a sibling temporary file and renames
// it over abs, unless abs no longer matches the state it was read in. The
// temporary file keeps the original's permissions.
func replaceIfUnchanged(abs string, read os.FileInfo, content []byte) (bool, error) {
	tmp, err := os.CreateTemp(filepath.Dir(abs), "."+filepath.Base(abs)+".*.tmp")
	if err != nil {
		return false, err
	}
	tmpPath := tmp.Name()
	discard := func() {
		if rmErr := os.Remove(tmpPath); rmErr != nil && !os.IsNotExist(rmErr) {
			utils.LogWithFields(utils.LevelWarn, "wikilinks", "propagate: temporary file not removed", map[string]any{"path": tmpPath, "error": rmErr.Error()})
		}
	}
	if _, err := tmp.Write(content); err != nil {
		tmp.Close() //nolint:errcheck // the write error is the one reported
		discard()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		discard()
		return false, err
	}
	if err := os.Chmod(tmpPath, read.Mode().Perm()); err != nil {
		discard()
		return false, err
	}

	now, err := os.Lstat(abs)
	if err != nil {
		discard()
		return false, fmt.Errorf("re-checking %s: %w", abs, err)
	}
	if !now.Mode().IsRegular() || now.Size() != read.Size() || !now.ModTime().Equal(read.ModTime()) {
		discard()
		return false, nil
	}
	if err := os.Rename(tmpPath, abs); err != nil {
		discard()
		return false, err
	}
	return true, nil
}
