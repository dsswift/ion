package context

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Duplicate reasons reported on DiscoverEvent.DuplicateReason when a
// candidate is skipped because an earlier file already supplied it.
const (
	// DuplicateSymlink: the candidate resolves (through symlinks) to a file
	// that was already loaded. A CLAUDE.md symlink pointing at AGENTS.md in
	// the same directory is the canonical case.
	DuplicateSymlink = "symlink"
	// DuplicateContent: the candidate is a distinct file whose bytes are
	// identical to a file that was already loaded.
	DuplicateContent = "content"
)

// DiscoverEvent describes one context-file candidate found during a walk.
// It is handed to WalkHooks.OnDiscover for every candidate that exists on
// disk, duplicates included, so a consumer sees every skip and why.
type DiscoverEvent struct {
	Path   string // absolute path of the candidate
	Source string // "global", "project", "parent", "nested"
	// DuplicateOf is the path of the earlier file this candidate duplicates.
	// Empty when the candidate is not a duplicate.
	DuplicateOf string
	// DuplicateReason is DuplicateSymlink or DuplicateContent when
	// DuplicateOf is set, empty otherwise.
	DuplicateReason string
}

// WalkHooks are optional observation and override seams for a context walk.
// The context package carries no extension dependency; callers adapt these to
// whatever hook system they run (the session wires them to the
// context_discover and context_load extension hooks).
type WalkHooks struct {
	// OnDiscover is called for each candidate. Returning true rejects it.
	// A duplicate is skipped whatever the return value.
	OnDiscover func(ev DiscoverEvent) (reject bool)
	// OnLoad is called with the include-expanded content of each accepted
	// file. It returns the content to inject (return the input unchanged to
	// keep it) and whether to reject the file.
	OnLoad func(path, content, source string) (out string, reject bool)
}

// dedupIndex tracks the identity of every file a walk has accepted, so the
// same instructions are never injected twice. Identity is the resolved real
// path and the SHA-256 of the bytes; a path string alone misses a symlink
// and its target, which are two strings for one file.
type dedupIndex struct {
	byPath map[string]bool
	byReal map[string]string // real path -> first path that supplied it
	byHash map[string]string // content hash -> first path that supplied it
}

func newDedupIndex() *dedupIndex {
	return &dedupIndex{
		byPath: make(map[string]bool),
		byReal: make(map[string]string),
		byHash: make(map[string]string),
	}
}

// seenPath reports whether this exact path string was already considered.
// The same path reached twice (cwd under ~/.ion, say) is the same file, not a
// duplicate of a different one, so it is skipped without an event.
func (d *dedupIndex) seenPath(fp string) bool { return d.byPath[fp] }

// classify returns the earlier path and reason when fp duplicates an accepted
// file, or ("", "") when it is new.
func (d *dedupIndex) classify(fp string, data []byte) (dupOf, reason string) {
	if first, ok := d.byReal[realPath(fp)]; ok {
		return first, DuplicateSymlink
	}
	if first, ok := d.byHash[contentHash(data)]; ok {
		return first, DuplicateContent
	}
	return "", ""
}

// record marks fp as accepted. A file a hook rejects is still recorded, so a
// symlink to it cannot bring the rejected instructions back in.
func (d *dedupIndex) record(fp string, data []byte) {
	d.byPath[fp] = true
	real := realPath(fp)
	if _, ok := d.byReal[real]; !ok {
		d.byReal[real] = fp
	}
	h := contentHash(data)
	if _, ok := d.byHash[h]; !ok {
		d.byHash[h] = fp
	}
}

func realPath(fp string) string {
	real, err := filepath.EvalSymlinks(fp)
	if err != nil {
		return fp
	}
	return real
}

func contentHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// acceptCandidate runs the dedup check and both hooks for one file that
// exists on disk. It returns the content to inject and true, or ("", false)
// when the file is skipped. Every skip is logged with its reason.
func acceptCandidate(cfg WalkerConfig, idx *dedupIndex, fp, source string, data []byte) (string, bool) {
	var dupOf, reason string
	if cfg.Deduplication {
		dupOf, reason = idx.classify(fp, data)
	}
	if cfg.Hooks.OnDiscover != nil {
		reject := cfg.Hooks.OnDiscover(DiscoverEvent{Path: fp, Source: source, DuplicateOf: dupOf, DuplicateReason: reason})
		if reject && dupOf == "" {
			idx.record(fp, data)
			utils.LogWithFields(utils.LevelInfo, "context", "context file rejected by discover hook", map[string]any{"path": fp, "source": source})
			return "", false
		}
	}
	if dupOf != "" {
		idx.byPath[fp] = true
		utils.LogWithFields(utils.LevelInfo, "context", "context file skipped as duplicate", map[string]any{"path": fp, "duplicate_of": dupOf, "reason": reason, "source": source})
		return "", false
	}
	idx.record(fp, data)

	content := string(data)
	if cfg.IncludeDirective != "" {
		content = ProcessIncludes(content, filepath.Dir(fp), cfg.IncludeDirective, nil, cfg.IncludeMaxDepth)
	}
	if cfg.Hooks.OnLoad != nil {
		out, reject := cfg.Hooks.OnLoad(fp, content, source)
		if reject {
			utils.LogWithFields(utils.LevelInfo, "context", "context file rejected by load hook", map[string]any{"path": fp, "source": source})
			return "", false
		}
		if out != content {
			utils.LogWithFields(utils.LevelInfo, "context", "context file content replaced by load hook", map[string]any{"path": fp, "source": source, "bytes_before": len(content), "bytes_after": len(out)})
		}
		content = out
	}
	utils.LogWithFields(utils.LevelDebug, "context", "context file accepted", map[string]any{"path": fp, "source": source, "bytes": len(content)})
	return content, true
}
