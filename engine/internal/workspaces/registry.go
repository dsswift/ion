// Package workspaces is the engine's model of protected workspace roots: the
// worktrees Ion cuts for isolated conversations.
//
// ── Why this is engine core ─────────────────────────────────────────────────
// A worktree exists to isolate one conversation's work onto its own branch.
// That fact imposes hard rules on what an agent tool call may do — a write
// from a worktree conversation into its base repo interleaves several
// conversations in one dirty checkout. Those rules are pure mechanism: they
// derive deterministically from one JSON record plus git state, they hold for
// every consumer that uses worktrees, and an agent tool call must be
// refusable regardless of which extensions happen to be loaded. So the engine
// owns them, at the same seam where permissions are checked, and extensions
// remain free to layer stricter policy through the tool_call hook.
//
// ── The record ──────────────────────────────────────────────────────────────
// Clients that create worktrees persist them under the Ion home:
//
//	~/.ion/worktree-registry.json      { entries: [{worktreePath, repoPath, …}] }
//
// The engine reads it, never writes it. Everything here fails OPEN: a
// missing or corrupt record yields an empty view and the check passes, because
// a false refusal in the directory where the operator is working is worse than
// a briefly missing guard. Every fail-open path logs.
package workspaces

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

const logTag = "workspaces"

// WorktreeEntry is one registered worktree: the isolated checkout and the main
// repository it was cut from.
//
// Everything past RepoPath is descriptive rather than load-bearing for
// containment — the guard needs only the two paths. They are decoded because
// workspace CONTEXT states facts about the worktrees an agent is working
// across, and a fact the engine has to re-derive from git is a fact it can get
// wrong. Unknown keys stay ignored: the desktop writes a superset and adding a
// field on either side must never disturb the reader.
type WorktreeEntry struct {
	WorktreePath string `json:"worktreePath"`
	RepoPath     string `json:"repoPath"`
	// BranchName is the worktree's own branch.
	BranchName string `json:"branchName,omitempty"`
	// SourceBranch is the branch the worktree was cut from.
	SourceBranch string `json:"sourceBranch,omitempty"`
	// Title is the operator-facing label for the worktree's work.
	Title string `json:"title,omitempty"`
	// CreatedAt / LandedAt are Unix ms; zero means absent. LandedAt being set
	// is the difference between pending work and work already in the source
	// branch, which changes what a redirect to that worktree would mean.
	CreatedAt int64 `json:"createdAt,omitempty"`
	LandedAt  int64 `json:"landedAt,omitempty"`
}

// Landed reports whether the worktree's work has already reached its source
// branch. A landed worktree is a poor redirect target: its contribution is in
// the base, so an edit there is no longer pending work.
func (e WorktreeEntry) Landed() bool { return e.LandedAt > 0 }

// Registry reads the worktree record with mtime-validated caching.
//
// The cache is validated by stat on EVERY read, never load-once. The failure a
// load-once cache produces is concrete: the engine daemon is long-lived, and a
// worktree registered mid-session (converting a live conversation to a
// worktree is an ordinary flow) must be visible to the very next tool call —
// otherwise the check concludes "not a worktree conversation" and passes
// base-repo writes from the exact conversation the operator just isolated.
// One stat per gated tool call is noise.
type Registry struct {
	mu sync.Mutex

	worktrees     []WorktreeEntry
	worktreesMt   int64
	worktreesOnce bool

	// ionDir overrides the Ion home for tests; empty means ~/.ion.
	ionDir string
}

// NewRegistry returns a registry reading from the default Ion home (~/.ion).
func NewRegistry() *Registry {
	return &Registry{}
}

// NewRegistryAt returns a registry reading records from dir instead of ~/.ion.
// Test seam; production callers use NewRegistry.
func NewRegistryAt(dir string) *Registry {
	return &Registry{ionDir: dir}
}

func (r *Registry) dir() string {
	if r.ionDir != "" {
		return r.ionDir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "cannot resolve home dir, workspace records unreadable", map[string]any{"error": err.Error()})
		return ""
	}
	return filepath.Join(home, ".ion")
}

// Worktrees returns the registered worktrees, re-reading the file when its
// mtime moved. A missing or corrupt file yields nil (fail open, logged).
func (r *Registry) Worktrees() []WorktreeEntry {
	r.mu.Lock()
	defer r.mu.Unlock()

	dir := r.dir()
	if dir == "" {
		return nil
	}
	file := filepath.Join(dir, "worktree-registry.json")

	st, err := os.Stat(file)
	if err != nil {
		// Missing registry is the normal no-worktrees state; drop any cache so
		// a re-created file is re-read.
		r.worktrees, r.worktreesOnce = nil, false
		return nil
	}
	if r.worktreesOnce && st.ModTime().UnixNano() == r.worktreesMt {
		return r.worktrees
	}

	raw, err := os.ReadFile(file)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "worktree registry unreadable, failing open", map[string]any{"path": file, "error": err.Error()})
		r.worktrees, r.worktreesOnce = nil, false
		return nil
	}
	var parsed struct {
		Entries []WorktreeEntry `json:"entries"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// A half-written file (the client writes atomically, but be defensive)
		// fails open and is NOT cached, so the next call re-reads it.
		utils.LogWithFields(utils.LevelWarn, logTag, "worktree registry malformed, failing open", map[string]any{"path": file, "error": err.Error()})
		r.worktrees, r.worktreesOnce = nil, false
		return nil
	}

	valid := parsed.Entries[:0]
	for _, e := range parsed.Entries {
		if e.WorktreePath != "" && e.RepoPath != "" {
			valid = append(valid, e)
		}
	}
	r.worktrees = valid
	r.worktreesMt = st.ModTime().UnixNano()
	r.worktreesOnce = true
	return r.worktrees
}
