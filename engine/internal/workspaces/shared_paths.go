package workspaces

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ── Why a worktree may write SOME base-repo paths ───────────────────────────
//
// Containment refuses a worktree conversation's writes into its base repo
// because such writes interleave several conversations in one dirty checkout
// and review cannot attribute the hunks afterwards (registry.go, containment.go).
// That rationale is exact, and it has an exact boundary: it depends on the
// write being something git can see. A path git IGNORES cannot interleave
// reviewable work, because no `git add -A` will ever stage it, no diff will
// show it, and no commit can carry it. The refusal protects review; where
// there is nothing to review, it protects nothing.
//
// The concrete gap this closes: durable operator artifacts that belong beside
// the code but must outlive the worktree that produced them — a retrospective,
// a generated report, a local analysis run. Written into the worktree they die
// with it at Retire; the base repo is the only location that survives, and it
// was unreachable.
//
// ── Both conditions are required ────────────────────────────────────────────
//
// A path is writable from a worktree only when it is BOTH:
//
//  1. declared in the base repo's committed `.ion/worktree.json` under
//     `worktree.sharedPaths`, and
//  2. confirmed gitignored by `git check-ignore` in the base repo.
//
// Declaration alone is not enough: a project could declare a tracked directory
// and reintroduce the interleaving the guard exists to prevent, so the ignore
// check is the engine's own verification rather than a matter of trust. The
// ignore check alone is not enough either: that would silently widen the gate
// to every ignored path in the repo — `node_modules`, build caches, `.env` —
// which no project asked for. Declaration is the opt-in; the ignore check is
// the proof the opt-in is safe. This mirrors provision-seed.ts, which refuses
// to seed any path git does not ignore so provisioning can never dirty
// `git status`.
//
// ── Why the manifest is read from the BASE REPO, never the worktree ─────────
//
// The manifest is committed, so a copy exists in every worktree — and reading
// that copy would be a hole straight through the guard. A conversation could
// edit `.ion/worktree.json` inside its own worktree, declare the whole repo
// shared, and write anywhere. The value of an engine-level refusal is that no
// amount of model reasoning gets past it; a self-authorizing manifest would
// make it advisory. The base repo's committed copy is the authority, so
// widening the allowance is a reviewed commit on the source branch rather than
// an uncommitted edit inside a sandbox.
//
// ── Fail direction ──────────────────────────────────────────────────────────
//
// Everything else in this package fails OPEN (a false refusal where the
// operator works is worse than a briefly missing guard). This is an ALLOWANCE,
// so it fails the other way for exactly the same reason: an unreadable
// manifest, a malformed manifest, or an unavailable git yields no shared paths,
// and the pre-existing refusal stands. Failing open here would mean a corrupt
// file silently disables containment. Every path logs.

// sharedPathManifest is the committed per-project provisioning manifest. Only
// the shared-path list is decoded; the desktop owns the rest (seed entries,
// setup command, bench verify) and unknown keys stay ignored so either side can
// add fields without disturbing this reader.
type sharedPathManifest struct {
	Worktree struct {
		SharedPaths []string `json:"sharedPaths"`
	} `json:"worktree"`
}

// sharedPathCache memoizes one repo's resolved shared roots, keyed by the
// manifest's mtime so a declaration edit is picked up on the next gated call
// without re-reading the file every time.
type sharedPathCache struct {
	mu    sync.Mutex
	byDir map[string]*sharedPathEntry
}

type sharedPathEntry struct {
	// mtime of the manifest these roots were resolved from.
	mtime int64
	// canonical absolute directories a worktree may write into.
	roots []string
}

// sharedRoots returns the canonical absolute base-repo directories that
// worktree conversations may write into, for one repo.
//
// The result is the intersection of "declared" and "gitignored": every entry
// has been read from the base repo's committed manifest AND confirmed ignored
// by git. An empty result means the allowance does not apply and the caller's
// refusal stands.
func (c *Checker) sharedRoots(repoPath string) []string {
	if c == nil || repoPath == "" {
		return nil
	}

	manifest := filepath.Join(repoPath, ".ion", "worktree.json")
	st, err := os.Stat(manifest)
	if err != nil {
		// No manifest is the normal case for most projects: no shared paths are
		// declared, so nothing is allowed. Debug, not warn — this is not a fault.
		utils.LogWithFields(utils.LevelDebug, logTag, "no worktree manifest, no shared paths", map[string]any{
			"repo": repoPath, "path": manifest,
		})
		return nil
	}
	mtime := st.ModTime().UnixNano()

	c.shared.mu.Lock()
	if entry, ok := c.shared.byDir[repoPath]; ok && entry.mtime == mtime {
		roots := entry.roots
		c.shared.mu.Unlock()
		return roots
	}
	c.shared.mu.Unlock()

	roots := c.resolveSharedRoots(repoPath, manifest)

	c.shared.mu.Lock()
	if c.shared.byDir == nil {
		c.shared.byDir = make(map[string]*sharedPathEntry)
	}
	c.shared.byDir[repoPath] = &sharedPathEntry{mtime: mtime, roots: roots}
	c.shared.mu.Unlock()

	return roots
}

// resolveSharedRoots reads the manifest and validates every declared path.
// Each rejection is logged with its reason, because a declaration that silently
// does nothing is indistinguishable from a broken guard.
func (c *Checker) resolveSharedRoots(repoPath, manifest string) []string {
	raw, err := os.ReadFile(manifest)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "worktree manifest unreadable, no shared paths allowed", map[string]any{
			"repo": repoPath, "path": manifest, "error": err.Error(),
		})
		return nil
	}

	var parsed sharedPathManifest
	if err := json.Unmarshal(raw, &parsed); err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "worktree manifest malformed, no shared paths allowed", map[string]any{
			"repo": repoPath, "path": manifest, "error": err.Error(),
		})
		return nil
	}

	declared := parsed.Worktree.SharedPaths
	if len(declared) == 0 {
		utils.LogWithFields(utils.LevelDebug, logTag, "worktree manifest declares no shared paths", map[string]any{
			"repo": repoPath,
		})
		return nil
	}

	canonicalRepo := c.canonical.get(repoPath)
	roots := make([]string, 0, len(declared))

	for _, decl := range declared {
		rel := strings.TrimSpace(decl)
		if rel == "" {
			continue
		}
		if filepath.IsAbs(rel) {
			utils.LogWithFields(utils.LevelWarn, logTag, "shared path rejected: must be repo-relative", map[string]any{
				"repo": repoPath, "declared": decl,
			})
			continue
		}

		// Resolve against the repo and require the result to stay inside it. A
		// `../` escape would hand out write access to an arbitrary directory
		// under the guise of a project declaration.
		abs := canonicalizePath(filepath.Join(repoPath, rel))
		if !isWithin(abs, canonicalRepo) {
			utils.LogWithFields(utils.LevelWarn, logTag, "shared path rejected: escapes the repository", map[string]any{
				"repo": repoPath, "declared": decl, "resolved": abs,
			})
			continue
		}
		if abs == canonicalRepo {
			utils.LogWithFields(utils.LevelWarn, logTag, "shared path rejected: cannot share the repository root", map[string]any{
				"repo": repoPath, "declared": decl,
			})
			continue
		}

		if !c.isGitIgnored(repoPath, rel) {
			utils.LogWithFields(utils.LevelWarn, logTag, "shared path rejected: git does not ignore it", map[string]any{
				"repo": repoPath, "declared": decl,
				"detail": "a declared shared path must be gitignored, otherwise a write there could be staged and would interleave conversations",
			})
			continue
		}

		utils.LogWithFields(utils.LevelInfo, logTag, "shared path accepted", map[string]any{
			"repo": repoPath, "declared": decl, "resolved": abs,
		})
		roots = append(roots, abs)
	}

	return roots
}

// isGitIgnored reports whether git ignores relPath within repoPath.
//
// `git check-ignore --quiet` exits 0 when the path IS ignored and non-zero when
// it is not, so a non-zero exit is the answer rather than an error.
//
// The trailing-slash retry matters: a directory-only pattern (`docs/retros/`,
// the form nearly every .gitignore uses) matches a bare path only when that
// path already exists as a directory. A shared path that has not been created
// yet would otherwise read as "not ignored" and be rejected on first use — the
// exact case the allowance exists to serve. Re-asking with an explicit trailing
// slash tells git to treat it as a directory. Same reasoning and same two-step
// as provision-seed.ts.
func (c *Checker) isGitIgnored(repoPath, relPath string) bool {
	ask := func(candidate string) bool {
		if _, err := c.git(repoPath, "check-ignore", "--quiet", "--", candidate); err != nil {
			return false
		}
		return true
	}
	if ask(relPath) {
		return true
	}
	if strings.HasSuffix(relPath, "/") {
		return false
	}
	return ask(relPath + "/")
}

// isSharedTarget reports whether an already-canonical path falls inside a
// declared, gitignored shared root of the worktree's base repo.
//
// Callers use this to convert a base-repo refusal into a pass. It is
// deliberately NOT consulted for sibling-worktree targets: a sibling is another
// conversation's live checkout, and a gitignored path there is that
// conversation's private build state, not a shared artifact directory.
func (c *Checker) isSharedTarget(canonicalTarget string, wc *WorktreeContainment) bool {
	if c == nil || wc == nil || canonicalTarget == "" {
		return false
	}
	for _, root := range c.sharedRoots(wc.RepoPath) {
		if isWithin(canonicalTarget, root) {
			return true
		}
	}
	return false
}
