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
	// BranchName is the worktree's own branch, the ref a member contributes.
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

// BenchMember is one worktree enrolled in a bench, pinned at a contribution.
// The pinned range (`pinnedBaseSha..pinnedSha`) is what owner attribution
// diffs when a refused bench write needs to name where the edit belongs.
type BenchMember struct {
	WorktreePath string `json:"worktreePath"`
	BranchName   string `json:"branchName"`
	Enabled      *bool  `json:"enabled,omitempty"`
	PinnedSha    string `json:"pinnedSha,omitempty"`
	PinnedBase   string `json:"pinnedBaseSha,omitempty"`
	// PinnedTreeHash / CurrentTreeHash are compared as TREE hashes, so an
	// amend or reword (new sha, identical tree) is not a false stale and a
	// rebase (changed content, no new commit) is not a missed one. Attribution
	// reports the difference as a warning: a stale member means the bench does
	// NOT hold that worktree's current work, so a diagnosis made in the bench
	// may already be answered in the member.
	PinnedTreeHash  string `json:"pinnedTreeHash,omitempty"`
	CurrentTreeHash string `json:"currentTreeHash,omitempty"`
	// Pin is the freshness axis ("empty", "current", "behind", "absorbed",
	// "gone"). Merge is the last assembly outcome for this member ("unbuilt",
	// "merged", "conflicted", "skipped"). Decoded as strings, never as a Go
	// enum: an unrecognized future value must pass through and be reported
	// verbatim rather than collapse to a wrong known value.
	Pin   string `json:"pin,omitempty"`
	Merge string `json:"merge,omitempty"`
	// Review is the operator verdict on the CURRENT pin ("good", "issue"), or
	// empty for unreviewed.
	Review string `json:"review,omitempty"`
	// ConflictPaths / ConflictsWith are populated when Merge == "conflicted":
	// the paths that did not merge and the earlier-merged member branches this
	// one collided with.
	ConflictPaths []string `json:"conflictPaths,omitempty"`
	ConflictsWith []string `json:"conflictsWith,omitempty"`
	// MergeResolution is "replayed" when a successful merge succeeded only
	// because a recorded resolution (git rerere) was replayed. A replayed
	// resolution is deterministic but it is not the same fact as a clean
	// merge, so it is surfaced rather than hidden.
	MergeResolution string `json:"mergeResolution,omitempty"`
}

// EnabledOrDefault reports whether the member takes part in the assembly.
// Absent means enabled — enrollment defaults to included.
func (m BenchMember) EnabledOrDefault() bool {
	return m.Enabled == nil || *m.Enabled
}

// Stale reports whether the member's current work differs from what the bench
// holds. Only answerable when BOTH tree hashes are recorded: an absent hash is
// unknown, and unknown must not read as "current" — that would assert
// freshness the record does not carry.
func (m BenchMember) Stale() bool {
	if m.PinnedTreeHash == "" || m.CurrentTreeHash == "" {
		return false
	}
	return m.PinnedTreeHash != m.CurrentTreeHash
}

// StalenessKnown reports whether Stale() had the two hashes it needs.
func (m BenchMember) StalenessKnown() bool {
	return m.PinnedTreeHash != "" && m.CurrentTreeHash != ""
}

// PinnedRange renders the member's contribution range in git syntax, or ""
// when the record cannot express one.
func (m BenchMember) PinnedRange() string {
	if m.PinnedBase == "" || m.PinnedSha == "" {
		return ""
	}
	return m.PinnedBase + ".." + m.PinnedSha
}

// EmptyContribution reports whether the member has committed nothing of its
// own. An equal base/tip pair is the one fact no git query at assembly time
// can recover once the source branch moves, so it is read from the record.
func (m BenchMember) EmptyContribution() bool {
	return m.PinnedBase != "" && m.PinnedBase == m.PinnedSha
}

// Assembly outcomes as the writer records them. Absent is UNKNOWN — never
// "failed" and never "assembled". A record written before atomic assembly
// existed carries neither.
const (
	AssemblyAssembled = "assembled"
	AssemblyFailed    = "failed"
)

// BenchWorkspace is one integration bench: a reassemblable worktree layering
// pinned member contributions onto a source branch.
type BenchWorkspace struct {
	RepoPath     string `json:"repoPath"`
	SourceBranch string `json:"sourceBranch"`
	BenchPath    string `json:"benchPath"`
	// BenchBranch is the ref the assembly recreates from scratch every time.
	// Named in context so an agent reading `git status` in a bench recognizes
	// the branch it is on as disposable.
	BenchBranch string `json:"benchBranch,omitempty"`
	BaseSha     string `json:"baseSha,omitempty"`
	// LastBuiltAt is Unix ms of the last assembly ATTEMPT; zero = never.
	LastBuiltAt int64 `json:"lastBuiltAt,omitempty"`
	// LastAssembly is "assembled", "failed", or empty for unknown.
	// A failed assembly wiped the bench to an empty tree, so attribution and
	// any build run there are answering questions about nothing — which is why
	// the outcome and its error are read rather than inferred from the tree.
	LastAssembly      string        `json:"lastAssembly,omitempty"`
	LastAssemblyError string        `json:"lastAssemblyError,omitempty"`
	Members           []BenchMember `json:"members,omitempty"`
}

// Assembled reports whether the last assembly is known to have succeeded.
// Unknown (absent outcome) is NOT assembled and NOT failed.
func (b BenchWorkspace) Assembled() bool { return b.LastAssembly == AssemblyAssembled }

// AssemblyFailed reports whether the last assembly is known to have failed,
// which means the bench holds no member content at all.
func (b BenchWorkspace) AssemblyFailed() bool { return b.LastAssembly == AssemblyFailed }

// EnabledMembers returns the members that take part in the assembly, in the
// recorded merge order. Order is contract: it is the order the assembly merges
// in, so it is the order in which collisions are attributed.
func (b BenchWorkspace) EnabledMembers() []BenchMember {
	var out []BenchMember
	for _, m := range b.Members {
		if m.EnabledOrDefault() {
			out = append(out, m)
		}
	}
	return out
}

// DisabledMembers returns the members kept in the list but skipped in the
// merge, in recorded order. Reported separately, never merged into the enabled
// list: their content is NOT in the bench, so treating them as contributors
// would attribute assembled bytes to work the bench never received.
func (b BenchWorkspace) DisabledMembers() []BenchMember {
	var out []BenchMember
	for _, m := range b.Members {
		if !m.EnabledOrDefault() {
			out = append(out, m)
		}
	}
	return out
}

// MemberFor returns the enrolled member whose worktree contains path, or nil.
func (b BenchWorkspace) MemberFor(path string) *BenchMember {
	for i := range b.Members {
		if isWithin(path, b.Members[i].WorktreePath) {
			return &b.Members[i]
		}
	}
	return nil
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
