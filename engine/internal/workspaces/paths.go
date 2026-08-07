package workspaces

import (
	"path/filepath"
	"sync"
)

// ── Why canonicalization is load-bearing here ───────────────────────────────
//
// Every rule in this package is a comparison between a path and a root. A
// comparison between two spellings of the same path is not a comparison at
// all, and it fails in BOTH directions:
//
//   - A symlink defeats the guard. A registered worktree reached through a
//     symlink elsewhere on disk is string-unequal to the recorded root, so an
//     edit through the link is not recognized as a contained write. macOS
//     makes this the DEFAULT rather than an exotic case: `/tmp` is a symlink
//     to `/private/tmp` and `/var` to `/private/var`, so a recorded path and
//     a resolved cwd routinely disagree with no user involvement.
//   - A traversal defeats it the same way. `<worktree>/../../repo/x.go` is
//     inside neither the worktree nor anything the raw string suggests.
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
// worse than a briefly missing guard.

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
// against. Roots are read from the record on every gated call, and resolving
// each one per call would add a symlink walk per root per tool call for values
// that change only when the record changes. Targets are NOT cached: each is
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
