package conversation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// FR-01: per-principal conversation storage partitioning.
//
// Disabled by default (SecurityConfig.PrincipalPartitioning nil/Enabled
// false): every function below is a no-op passthrough to the flat
// `conversations/` root, byte-identical to today's behavior. Enabling it
// starts a multi-tenant engine SCRATCH -- there is no migration of
// pre-existing flat data (locked decision; a single-user machine that later
// becomes a multi-tenant deployment is a fresh instance, never the same
// data directory).
//
// Layout when enabled: `<root>/principals/<PrincipalDir(subject)>/conversations/`.
// `<root>/conversations/` (the flat root) remains the home for every
// UNATTRIBUTED session (no principal) -- it can never see a partition, and a
// partitioned session can never see the flat root or another partition's,
// subject to the configured PrincipalEnforcement level.

var (
	partitionMu     sync.RWMutex
	partitionCfg    *types.PrincipalPartitioningConfig
	partitionRoot   string                // the resolved DefaultConversationsDir() at Configure time
	partitionIndex  = map[string]string{} // conversationID -> absolute partition "conversations" dir
	notSanitizedRun = regexp.MustCompile(`[^a-zA-Z0-9_.-]+`)
)

const principalDirSubjectMaxLen = 40

// PrincipalDir derives the on-disk directory name for a principal's
// partition: a sanitized, length-capped, human-readable prefix of the
// subject, followed by a SHA-256 hash suffix that makes collisions between
// two different subjects that sanitize to the same prefix impossible.
// Deterministic and collision-free; never reversed back to the raw subject
// from the directory name alone (the `principal.json` marker inside it
// carries the real subject for that).
func PrincipalDir(subject string) string {
	sanitized := notSanitizedRun.ReplaceAllString(subject, "-")
	sanitized = strings.Trim(sanitized, "-")
	if len(sanitized) > principalDirSubjectMaxLen {
		sanitized = sanitized[:principalDirSubjectMaxLen]
	}
	if sanitized == "" {
		sanitized = "principal"
	}
	sum := sha256.Sum256([]byte(subject))
	return sanitized + "--" + hex.EncodeToString(sum[:])[:16]
}

// principalMarker is the durable record written once per partition
// directory, so a partition's owner can be recovered from disk alone
// (recovery tooling, an operator inspecting the filesystem) without
// reversing PrincipalDir's hash.
type principalMarker struct {
	Subject  string `json:"subject"`
	Provider string `json:"provider,omitempty"`
}

// PartitioningEnabled reports whether FR-01 partitioning is active for this
// process. Safe for concurrent use.
func PartitioningEnabled() bool {
	partitionMu.RLock()
	defer partitionMu.RUnlock()
	return partitionCfg != nil && partitionCfg.Enabled
}

// PartitioningEnforcement returns the effective enforcement level, or
// EnforcementNone when partitioning is disabled.
func PartitioningEnforcement() types.PrincipalEnforcement {
	partitionMu.RLock()
	defer partitionMu.RUnlock()
	return partitionCfg.ResolvedEnforcement()
}

// PartitionRoot returns the flat conversations root partitioning was
// configured against (== DefaultConversationsDir() at Configure time), for
// callers that need to compose a principal's absolute partition path
// themselves (e.g. the session package's per-partition sidecar files).
func PartitionRoot() string {
	partitionMu.RLock()
	defer partitionMu.RUnlock()
	return partitionRoot
}

// principalsRoot is `<partitionRoot's parent>/principals` -- a sibling of
// the flat `conversations/` directory, not nested inside it, so an
// unattributed session's flat-root listing never enumerates partitions.
func principalsRoot(root string) string {
	return filepath.Join(filepath.Dir(root), "principals")
}

// PartitionConversationsDir returns the absolute `conversations/`
// subdirectory for subject's partition, without checking whether
// partitioning is enabled or the directory exists. Exported for the session
// package's per-partition sidecars (user-images, dispatch outboxes) that
// need the same directory Save resolves to.
func PartitionConversationsDir(subject string) string {
	partitionMu.RLock()
	root := partitionRoot
	partitionMu.RUnlock()
	if root == "" {
		root = DefaultConversationsDir()
	}
	return filepath.Join(principalsRoot(root), PrincipalDir(subject), "conversations")
}

// ConfigurePartitioning activates or deactivates FR-01 for this process.
// Called once at boot, after config load, from cmd_serve.go. A nil or
// disabled cfg clears any prior state (partitioning is a live-toggleable
// process setting, not something that requires a restart to disable, which
// matters for tests that reconfigure between cases).
func ConfigurePartitioning(root string, cfg *types.PrincipalPartitioningConfig) {
	partitionMu.Lock()
	partitionCfg = cfg
	partitionRoot = root
	partitionIndex = map[string]string{}
	enabled := cfg != nil && cfg.Enabled
	partitionMu.Unlock()

	if !enabled {
		utils.Log("conversation.partition", "principal partitioning disabled")
		return
	}
	enforcement := cfg.ResolvedEnforcement()
	if enforcement == types.EnforcementNone {
		utils.LogWithFields(utils.LevelWarn, "conversation.partition", "principal partitioning enabled with enforcement=none: every session can read/write every partition", nil)
	}
	utils.LogWithFields(utils.LevelInfo, "conversation.partition", "principal partitioning enabled", map[string]any{
		"root": root, "enforcement": string(enforcement),
	})
	rebuildPartitionIndex(root)
}

// rebuildPartitionIndex walks `<root's parent>/principals/*/conversations`
// and indexes every conversation ID found (by scanning for `.llm.jsonl` /
// `.tree.jsonl` / legacy `.jsonl` / `.json` file basenames, the same probe
// ListStored already performs on the flat root). Errors reading a single
// partition directory are logged and skipped -- a corrupt or unreadable
// partition must never crash boot or hide every OTHER partition's index.
func rebuildPartitionIndex(root string) {
	base := principalsRoot(root)
	entries, err := os.ReadDir(base)
	if err != nil {
		if !os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelError, "conversation.partition", "principals root unreadable during index rebuild", map[string]any{"path": base, "error": err.Error()})
		}
		return
	}

	index := map[string]string{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		convDir := filepath.Join(base, e.Name(), "conversations")
		ids, err := conversationIDsIn(convDir)
		if err != nil {
			if !os.IsNotExist(err) {
				utils.LogWithFields(utils.LevelError, "conversation.partition", "partition directory unreadable during index rebuild", map[string]any{"path": convDir, "error": err.Error()})
			}
			continue
		}
		for _, id := range ids {
			index[id] = convDir
		}
	}

	partitionMu.Lock()
	partitionIndex = index
	partitionMu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "conversation.partition", "principal index rebuilt", map[string]any{"conversation_count": len(index), "partition_dirs": len(entries)})
}

// conversationIDsIn lists the distinct conversation IDs present in dir,
// recognizing every on-disk format Load/Exists probe (split, legacy jsonl,
// legacy json).
func conversationIDsIn(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var ids []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		var id string
		switch {
		case strings.HasSuffix(name, ".llm.jsonl"):
			id = strings.TrimSuffix(name, ".llm.jsonl")
		case strings.HasSuffix(name, ".tree.jsonl"):
			id = strings.TrimSuffix(name, ".tree.jsonl")
		case strings.HasSuffix(name, ".jsonl"):
			id = strings.TrimSuffix(name, ".jsonl")
		case strings.HasSuffix(name, ".json"):
			id = strings.TrimSuffix(name, ".json")
		default:
			continue
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids, nil
}

// registerPartitionEntry records id's owning partition directory
// immediately, so a conversation minted this process lifetime resolves
// correctly before the next full index rebuild (there is none scheduled --
// this IS the live update path; rebuildPartitionIndex only runs at
// Configure time).
func registerPartitionEntry(id, dir string) {
	if id == "" {
		return
	}
	partitionMu.Lock()
	partitionIndex[id] = dir
	partitionMu.Unlock()
}

// unregisterPartitionEntry removes id from the live index (deletion/cleanup).
func unregisterPartitionEntry(id string) {
	partitionMu.Lock()
	delete(partitionIndex, id)
	partitionMu.Unlock()
}

// lookupPartitionDir returns id's indexed partition directory, if any.
func lookupPartitionDir(id string) (string, bool) {
	partitionMu.RLock()
	defer partitionMu.RUnlock()
	dir, ok := partitionIndex[id]
	return dir, ok
}

// ensurePrincipalMarker writes `<dir>/principal.json` the first time a
// partition is created. Best-effort: a failure here logs but never blocks
// the save it accompanies -- the marker is recovery metadata, not load-bearing
// for correctness (PrincipalDir's mapping is already deterministic).
func ensurePrincipalMarker(dir string, principal *types.ConversationPrincipal) {
	markerPath := filepath.Join(dir, "principal.json")
	if _, err := os.Stat(markerPath); err == nil {
		return
	}
	data, err := json.MarshalIndent(principalMarker{Subject: principal.Subject, Provider: principal.Provider}, "", "  ")
	if err != nil {
		utils.LogWithFields(utils.LevelError, "conversation.partition", "principal marker marshal failed", map[string]any{"error": err.Error()})
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		utils.LogWithFields(utils.LevelError, "conversation.partition", "principal marker mkdir failed", map[string]any{"path": dir, "error": err.Error()})
		return
	}
	if err := os.WriteFile(markerPath, data, 0o644); err != nil {
		utils.LogWithFields(utils.LevelError, "conversation.partition", "principal marker write failed", map[string]any{"path": markerPath, "error": err.Error()})
	}
}

// resolveSaveDir derives Save's target directory from conv.Principal when
// partitioning is enabled and conv is attributed; the flat root otherwise
// (disabled, or an unattributed conversation -- which must never be
// silently partitioned just because SOME other session is).
func resolveSaveDir(conv *Conversation) string {
	partitionMu.RLock()
	enabled := partitionCfg != nil && partitionCfg.Enabled
	root := partitionRoot
	partitionMu.RUnlock()

	flat := DefaultConversationsDir()
	if !enabled || conv == nil || conv.Principal == nil || conv.Principal.Subject == "" {
		return flat
	}
	if root == "" {
		root = flat
	}
	dir := filepath.Join(principalsRoot(root), PrincipalDir(conv.Principal.Subject), "conversations")
	ensurePrincipalMarker(dir, conv.Principal)
	registerPartitionEntry(conv.ID, dir)
	return dir
}

// resolveDir is the read-side counterpart of resolveSaveDir: id's indexed
// partition directory when partitioning is enabled and the index has an
// entry, the flat root otherwise (disabled, or an id the index has never
// seen -- e.g. an unattributed conversation, which by construction is never
// indexed since resolveSaveDir only indexes attributed saves).
func resolveDir(id string) string {
	if !PartitioningEnabled() {
		return DefaultConversationsDir()
	}
	if dir, ok := lookupPartitionDir(id); ok {
		return dir
	}
	return DefaultConversationsDir()
}

// DirFor is resolveDir's exported form, for the session package's
// per-partition sidecar files (agent_dispatch_outbox.go, start_session.go,
// event_translation.go, backend/runloop.go, legacy_recovery_repair.go) that
// need the same directory Load/Save resolve a conversation ID to, without
// duplicating the resolution logic.
func DirFor(id string) string {
	return resolveDir(id)
}

// ListStoredFor lists stored conversations in subject's own partition. On a
// non-partitioned engine (or a subject that owns no partition) this is
// simply empty -- callers that want the flat root's listing use ListStored
// with dir="" directly, unchanged.
func ListStoredFor(subject string, limit int) ([]types.StoredSessionInfo, error) {
	if subject == "" {
		return []types.StoredSessionInfo{}, nil
	}
	return ListStored(PartitionConversationsDir(subject), limit)
}

// ResetPartitioningForTest clears all partitioning state. TEST ONLY.
func ResetPartitioningForTest() {
	partitionMu.Lock()
	partitionCfg = nil
	partitionRoot = ""
	partitionIndex = map[string]string{}
	partitionMu.Unlock()
}
