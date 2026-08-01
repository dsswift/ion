// Package workspaces is the engine's model of protected workspace roots:
// the worktrees Ion cuts for isolated conversations and the integration
// benches it assembles from them.
//
// ── Why this is engine core ─────────────────────────────────────────────────
// A worktree exists to isolate one conversation's work onto its own branch,
// and a bench is a disposable assembly whose branch is recreated from scratch
// on every build. Both facts impose hard rules on what an agent tool call may
// do — a write from a worktree conversation into its base repo interleaves
// several conversations in one dirty checkout, and a commit in a bench is
// destroyed by the next assembly. Those rules are pure mechanism: they derive
// deterministically from two JSON records plus git state, they hold for every
// consumer that uses worktrees or benches, and an agent tool call must be
// refusable regardless of which extensions happen to be loaded. So the engine
// owns them, at the same seam where permissions are checked, and extensions
// remain free to layer stricter policy through the tool_call hook.
//
// ── The two records ─────────────────────────────────────────────────────────
// Clients that create worktrees and benches persist them under the Ion home:
//
//	~/.ion/worktree-registry.json      { entries: [{worktreePath, repoPath, …}] }
//	~/.ion/integration-workspaces.json { workspaces: [{benchPath, baseSha, members, …}] }
//
// The engine reads both, never writes them. Everything here fails OPEN: a
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
type WorktreeEntry struct {
	WorktreePath string `json:"worktreePath"`
	RepoPath     string `json:"repoPath"`
}

// BenchMember is one worktree enrolled in a bench, pinned at a contribution.
// The pinned range (`pinnedBaseSha..pinnedSha`) is what owner attribution
// diffs when a refused bench write needs to name where the edit belongs.
type BenchMember struct {
	WorktreePath string `json:"worktreePath"`
	BranchName   string `json:"branchName"`
	Enabled      *bool  `json:"enabled,omitempty"`
	PinnedSha    string `json:"pinnedSha,omitempty"`
	PinnedBase   string `json:"pinnedBaseSha,omitempty"`
}

// EnabledOrDefault reports whether the member takes part in the assembly.
// Absent means enabled — enrollment defaults to included.
func (m BenchMember) EnabledOrDefault() bool {
	return m.Enabled == nil || *m.Enabled
}

// BenchWorkspace is one integration bench: a reassemblable worktree layering
// pinned member contributions onto a source branch.
type BenchWorkspace struct {
	RepoPath     string        `json:"repoPath"`
	SourceBranch string        `json:"sourceBranch"`
	BenchPath    string        `json:"benchPath"`
	BaseSha      string        `json:"baseSha,omitempty"`
	Members      []BenchMember `json:"members,omitempty"`
}

// Registry reads the two workspace records with mtime-validated caching.
//
// The cache is validated by stat on EVERY read, never load-once. The failure a
// load-once cache produces is concrete: the engine daemon is long-lived, and a
// worktree registered mid-session (converting a live conversation to a
// worktree is an ordinary flow) must be visible to the very next tool call —
// otherwise the check concludes "not a worktree conversation" and passes
// base-repo writes from the exact conversation the operator just isolated.
// One stat per gated tool call is noise next to the git subprocesses the
// bench rules already run.
type Registry struct {
	mu sync.Mutex

	worktrees     []WorktreeEntry
	worktreesMt   int64
	worktreesOnce bool

	benches     []BenchWorkspace
	benchesMt   int64
	benchesOnce bool

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

// Benches returns the integration workspaces, re-reading the file when its
// mtime moved. Same fail-open, no-cache-on-error posture as Worktrees.
func (r *Registry) Benches() []BenchWorkspace {
	r.mu.Lock()
	defer r.mu.Unlock()

	dir := r.dir()
	if dir == "" {
		return nil
	}
	file := filepath.Join(dir, "integration-workspaces.json")

	st, err := os.Stat(file)
	if err != nil {
		r.benches, r.benchesOnce = nil, false
		return nil
	}
	if r.benchesOnce && st.ModTime().UnixNano() == r.benchesMt {
		return r.benches
	}

	raw, err := os.ReadFile(file)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "integration workspaces unreadable, failing open", map[string]any{"path": file, "error": err.Error()})
		r.benches, r.benchesOnce = nil, false
		return nil
	}
	var parsed struct {
		Workspaces []BenchWorkspace `json:"workspaces"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "integration workspaces malformed, failing open", map[string]any{"path": file, "error": err.Error()})
		r.benches, r.benchesOnce = nil, false
		return nil
	}

	valid := parsed.Workspaces[:0]
	for _, w := range parsed.Workspaces {
		if w.BenchPath != "" {
			valid = append(valid, w)
		}
	}
	r.benches = valid
	r.benchesMt = st.ModTime().UnixNano()
	r.benchesOnce = true
	return r.benches
}
