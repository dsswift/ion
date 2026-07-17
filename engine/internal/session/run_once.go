package session

import (
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// RunOnceCheckResult is the return value of RunOnceCheck on the Manager.
type RunOnceCheckResult struct {
	Execute bool   // true when this caller should run the operation
	Reason  string // "in_progress", "debounced", or "already_ran" when Execute=false
}

// runOnceEntry tracks state for a single deduplicated operation.
type runOnceEntry struct {
	lastRun time.Time
	running bool
}

// runOnceRegistry is the Manager-level registry for cross-instance dedup.
// Keyed by extensionPath -> operationId -> entry.
type runOnceRegistry struct {
	mu  sync.Mutex
	ops map[string]map[string]*runOnceEntry
}

func newRunOnceRegistry() *runOnceRegistry {
	return &runOnceRegistry{
		ops: make(map[string]map[string]*runOnceEntry),
	}
}

// check determines whether this caller should execute the named operation.
// Returns Execute=true when this caller wins the dedup check. The caller must
// call complete after execution (success or failure).
func (r *runOnceRegistry) check(extensionPath, operationID string, debounceMs int64) RunOnceCheckResult {
	r.mu.Lock()
	defer r.mu.Unlock()

	ops, ok := r.ops[extensionPath]
	if !ok {
		ops = make(map[string]*runOnceEntry)
		r.ops[extensionPath] = ops
	}

	entry, exists := ops[operationID]
	if !exists {
		entry = &runOnceEntry{}
		ops[operationID] = entry
	}

	if entry.running {
		return RunOnceCheckResult{Execute: false, Reason: "in_progress"}
	}

	if !entry.lastRun.IsZero() {
		if debounceMs == 0 {
			return RunOnceCheckResult{Execute: false, Reason: "already_ran"}
		}
		if time.Since(entry.lastRun) < time.Duration(debounceMs)*time.Millisecond {
			return RunOnceCheckResult{Execute: false, Reason: "debounced"}
		}
	}

	entry.running = true
	utils.LogWithFields(utils.LevelInfo, "runonce", "acquired", map[string]any{"extension_path": extensionPath, "run_id": operationID, "debounce_ms": debounceMs})
	return RunOnceCheckResult{Execute: true}
}

// complete marks an operation as finished. failed=true clears running without
// recording lastRun so the next instance can retry immediately. failed=false
// records lastRun to start the debounce window.
func (r *runOnceRegistry) complete(extensionPath, operationID string, failed bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	ops, ok := r.ops[extensionPath]
	if !ok {
		return
	}
	entry, ok := ops[operationID]
	if !ok {
		return
	}

	entry.running = false
	if !failed {
		entry.lastRun = time.Now()
	}
	utils.LogWithFields(utils.LevelDebug, "runonce", "completed", map[string]any{"extension_path": extensionPath, "run_id": operationID, "failed": failed})
}

// runningIDs returns the operation IDs that are currently marked as running
// for the given extension path. Used by host death handling to release stale
// leases when a subprocess crashes without sending run_once_complete.
func (r *runOnceRegistry) runningIDs(extensionPath string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()

	ops, ok := r.ops[extensionPath]
	if !ok {
		return nil
	}
	var ids []string
	for id, entry := range ops {
		if entry.running {
			ids = append(ids, id)
		}
	}
	return ids
}

// releaseRunning clears the running flag for the given operation without
// recording lastRun. This lets the next instance retry immediately instead
// of waiting for debounce expiry.
func (r *runOnceRegistry) releaseRunning(extensionPath, operationID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	ops, ok := r.ops[extensionPath]
	if !ok {
		return
	}
	entry, ok := ops[operationID]
	if !ok {
		return
	}
	if entry.running {
		entry.running = false
		utils.LogWithFields(utils.LevelDebug, "runonce", "released running (host death)", map[string]any{"extension_path": extensionPath, "run_id": operationID})
	}
}

// purgeExtension removes all runOnce entries for the given extension path.
// Called when the last session for an extension stops.
func (r *runOnceRegistry) purgeExtension(extensionPath string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.ops[extensionPath]; ok {
		delete(r.ops, extensionPath)
		utils.LogWithFields(utils.LevelInfo, "runonce", "cleared all entries for (last session stopped)", map[string]any{"extension_path": extensionPath})
	}
}

// RunOnceCheck checks if an operation should execute, keyed by session.
// It resolves the session's extension path from the loaded extension group.
// Returns Execute=true when this caller should run the operation.
// Returns Execute=false when the session does not exist.
// Returns Execute=true when the session exists but has no extension loaded
// (dedup is not applicable).
func (m *Manager) RunOnceCheck(sessionKey, operationID string, debounceMs int64) RunOnceCheckResult {
	m.mu.RLock()
	s, ok := m.sessions[sessionKey]
	m.mu.RUnlock()
	if !ok {
		// Session not found: deny. Callers should not race session lifecycle.
		return RunOnceCheckResult{Execute: false, Reason: "no_session"}
	}
	extPath := sessionExtDir(s)
	if extPath == "" {
		// No extension loaded for this session: allow execution (dedup N/A).
		return RunOnceCheckResult{Execute: true}
	}
	return m.runOnce.check(extPath, operationID, debounceMs)
}

// RunOnceComplete records the outcome of a runOnce operation for a session.
// failed=true releases the lock without updating lastRun so the next instance
// can retry immediately.
func (m *Manager) RunOnceComplete(sessionKey, operationID string, failed bool) {
	m.mu.RLock()
	s, ok := m.sessions[sessionKey]
	m.mu.RUnlock()
	if !ok {
		return
	}
	extPath := sessionExtDir(s)
	if extPath == "" {
		return
	}
	m.runOnce.complete(extPath, operationID, failed)
}

// extensionDirSessionCount returns the number of active sessions that have a
// host with the given extension directory. Caller must hold m.mu (read or write).
func (m *Manager) extensionDirSessionCount(extDir string) int {
	count := 0
	for _, s := range m.sessions {
		if s.extGroup == nil {
			continue
		}
		for _, h := range s.extGroup.Hosts() {
			if h.ExtensionDir() == extDir {
				count++
				break // one host match is enough to count the session
			}
		}
	}
	return count
}

// sessionExtDir returns the extension directory of the first loaded host in
// the session's extension group, or "" when none is loaded.
func sessionExtDir(s *engineSession) string {
	if s == nil || s.extGroup == nil {
		return ""
	}
	hosts := s.extGroup.Hosts()
	if len(hosts) == 0 {
		return ""
	}
	return hosts[0].ExtensionDir()
}
