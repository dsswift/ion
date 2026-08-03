package workspaces

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ── Why canonicalization is load-bearing here ───────────────────────────────
//
// Every rule in this package is a comparison between a path and a root. A
// comparison between two spellings of the same path is not a comparison at
// all, and it fails in BOTH directions:
//
//   - A symlink defeats the guard. `~/.ion/integration/project-main` reached
//     through a symlink elsewhere on disk is string-unequal to the recorded
//     bench path, so an edit through the link is not recognized as a bench
//     edit and the write lands in a directory the next assembly destroys.
//     macOS makes this the DEFAULT rather than an exotic case: `/tmp` is a
//     symlink to `/private/tmp` and `/var` to `/private/var`, so a recorded
//     path and a resolved cwd routinely disagree with no user involvement.
//   - A traversal defeats it the same way. `<bench>/../../source/x.go` is
//     inside neither the bench nor anything the raw string suggests.
//
// So both sides are canonicalized before any containment question is asked:
// made absolute, lexically cleaned, and symlink-resolved as deeply as the
// filesystem allows. The result is that one path has one spelling, and a
// prefix comparison over canonical forms means what it appears to mean.
//
// Canonicalization NEVER refuses on its own. A path that cannot be resolved
// (nonexistent parents, a permission error mid-walk) falls back to its
// lexically-cleaned absolute form: that is the same posture as the rest of the
// package, where a false refusal in the directory the operator is working in is
// worse than a briefly missing guard. Rejection is a separate, explicit
// decision made by the caller — attribution rejects an out-of-bench path,
// containment classifies it.

// pathRejection names why a path was refused entry to a bench-relative
// operation, so a caller can report the exact cause instead of "bad path".
type pathRejection string

const (
	rejectEmpty     pathRejection = "empty_path"
	rejectRelative  pathRejection = "not_absolute"
	rejectTraversal pathRejection = "traversal_escapes_root"
	rejectOutside   pathRejection = "outside_root"
	rejectNulByte   pathRejection = "nul_byte"
)

// canonicalizePath returns an absolute, lexically clean, symlink-resolved form
// of path.
//
// Resolution walks from the deepest EXISTING ancestor: a write target need not
// exist yet, and `EvalSymlinks` on a nonexistent leaf fails outright, which
// would leave every new-file write uncanonicalized while every existing-file
// write was canonicalized — the two spellings would then disagree for the same
// directory. Resolving the existing prefix and re-joining the missing tail
// gives one answer for both.
func canonicalizePath(path string) string {
	if path == "" {
		return ""
	}
	abs := path
	if !filepath.IsAbs(abs) {
		// A relative path has no meaning without a base; the caller resolves
		// against cwd before calling. Clean it and return so the value is at
		// least stable rather than silently rewritten against this process's
		// working directory, which is never the conversation's cwd.
		return filepath.Clean(abs)
	}
	abs = filepath.Clean(abs)

	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved)
	}

	// Walk up to the deepest existing ancestor, resolve that, re-join the tail.
	remainder := ""
	current := abs
	for {
		parent := filepath.Dir(current)
		if parent == current {
			// Reached the root without finding anything resolvable.
			return abs
		}
		remainder = filepath.Join(filepath.Base(current), remainder)
		current = parent
		resolved, err := filepath.EvalSymlinks(current)
		if err != nil {
			continue
		}
		return filepath.Clean(filepath.Join(resolved, remainder))
	}
}

// canonicalCache memoizes canonicalization for the roots a Checker compares
// against. Roots are read from the records on every gated call, and resolving
// each one per call would add a symlink walk per root per tool call for values
// that change only when the records change. Targets are NOT cached: each is
// seen once.
type canonicalCache struct {
	mu     sync.Mutex
	byPath map[string]string
}

func (c *canonicalCache) get(path string) string {
	if path == "" {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byPath == nil {
		c.byPath = make(map[string]string, 16)
	}
	if hit, ok := c.byPath[path]; ok {
		return hit
	}
	resolved := canonicalizePath(path)
	c.byPath[path] = resolved
	return resolved
}

// resolveWithin canonicalizes target against root and returns the relative
// path when target is root or a descendant.
//
// This is the single gate for "is this file inside this bench". It rejects
// rather than fails open, because its callers are read-only attribution and
// path classification, where an out-of-root path is a caller error with a real
// answer ("that file is not in this bench"), not a guard that might
// over-refuse someone's work.
//
// target must be the caller's RAW spelling, not a `filepath.Join`ed form.
// Joining cleans, and cleaning erases the `..` segments — which is exactly the
// evidence needed to tell a traversal ("you passed a path that looked
// contained") from a plainly external path. Reporting a traversal as merely
// "outside" hides the more interesting of the two cases.
func resolveWithin(target, root string) (rel string, canonicalTarget string, rejection pathRejection) {
	if target == "" {
		return "", "", rejectEmpty
	}
	if strings.ContainsRune(target, 0) {
		return "", "", rejectNulByte
	}
	if !filepath.IsAbs(target) {
		return "", "", rejectRelative
	}
	hadTraversal := hasDotDotSegment(target)
	canonicalTarget = canonicalizePath(target)
	canonicalRoot := canonicalizePath(root)
	if canonicalRoot == "" {
		return "", canonicalTarget, rejectOutside
	}
	if !isWithin(canonicalTarget, canonicalRoot) {
		if hadTraversal {
			return "", canonicalTarget, rejectTraversal
		}
		return "", canonicalTarget, rejectOutside
	}
	rel, err := filepath.Rel(canonicalRoot, canonicalTarget)
	if err != nil {
		return "", canonicalTarget, rejectOutside
	}
	if rel == "." {
		// The root itself is a directory, never an attributable file.
		return "", canonicalTarget, rejectOutside
	}
	return filepath.ToSlash(rel), canonicalTarget, ""
}

// hasDotDotSegment reports whether path contains a `..` PATH SEGMENT. Checked
// per segment rather than with a substring match, so a legitimate filename such
// as `notes..txt` or a directory named `..hidden` is not misreported as a
// traversal attempt.
func hasDotDotSegment(path string) bool {
	for _, segment := range strings.Split(filepath.ToSlash(path), "/") {
		if segment == ".." {
			return true
		}
	}
	return false
}

// joinRaw joins a base and a relative path WITHOUT cleaning, so `..` segments
// survive for resolveWithin to classify. filepath.Join would clean them away.
func joinRaw(base, rel string) string {
	if base == "" {
		return rel
	}
	return base + string(filepath.Separator) + rel
}

// pathExists reports whether path is present on disk. Used to tell a deleted
// file (attributable through history) from a never-existing one.
func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
