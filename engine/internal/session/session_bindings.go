package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// sessionBindings is the JSON schema for the key->conversationId sidecar.
// It maps session key strings to their most recently established conversationId.
// Written whenever a session's conversation id is established; read on
// StartSession for resume-on-restart.
type sessionBindings struct {
	Bindings map[string]string `json:"bindings"`
}

// bindingsPath returns the path to the session-bindings sidecar file.
// Honors ION_SESSION_BINDINGS_PATH for test isolation.
func bindingsPath() string {
	if v := os.Getenv("ION_SESSION_BINDINGS_PATH"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ion", "session-bindings.json")
}

// loadBindings reads the binding sidecar from disk. Returns an empty map
// on any error (missing file is not an error -- just means first run).
func loadBindings(path string) map[string]string {
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			utils.Log("session-bindings", fmt.Sprintf("load: %v", err))
		}
		return make(map[string]string)
	}
	var sb sessionBindings
	if err := json.Unmarshal(data, &sb); err != nil {
		utils.Log("session-bindings", fmt.Sprintf("unmarshal: %v", err))
		return make(map[string]string)
	}
	if sb.Bindings == nil {
		return make(map[string]string)
	}
	return sb.Bindings
}

// saveBinding atomically persists key->conversationId to the sidecar.
// Best-effort: I/O errors are logged and never fatal.
func saveBinding(path, key, conversationID string) {
	bindings := loadBindings(path)
	bindings[key] = conversationID

	sb := sessionBindings{Bindings: bindings}
	data, err := json.Marshal(sb)
	if err != nil {
		utils.Log("session-bindings", fmt.Sprintf("marshal: %v", err))
		return
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		utils.Log("session-bindings", fmt.Sprintf("mkdir: %v", err))
		return
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		utils.Log("session-bindings", fmt.Sprintf("write tmp: %v", err))
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		utils.Log("session-bindings", fmt.Sprintf("rename: %v", err))
		return
	}
	utils.Log("session-bindings", fmt.Sprintf("saved: key=%s conversationId=%s", key, conversationID))
}

// lookupBinding returns the previously persisted conversationId for the given
// key, or "" if none is stored.
func lookupBinding(path, key string) string {
	bindings := loadBindings(path)
	return bindings[key]
}

// deleteBinding removes the stored binding for a key, if present. Used by the
// ForceNewConversation path so the prior conversation is no longer
// auto-resumed for this key even while the freshly minted conversation's own
// binding is deferred until first save. Best-effort; a missing key is a no-op.
func deleteBinding(path, key string) {
	bindings := loadBindings(path)
	if _, ok := bindings[key]; !ok {
		return
	}
	delete(bindings, key)

	sb := sessionBindings{Bindings: bindings}
	data, err := json.Marshal(sb)
	if err != nil {
		utils.Log("session-bindings", fmt.Sprintf("delete marshal: %v", err))
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		utils.Log("session-bindings", fmt.Sprintf("delete mkdir: %v", err))
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		utils.Log("session-bindings", fmt.Sprintf("delete write tmp: %v", err))
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		utils.Log("session-bindings", fmt.Sprintf("delete rename: %v", err))
		return
	}
	utils.Log("session-bindings", fmt.Sprintf("deleted: key=%s", key))
}

// flushPendingBinding writes a deferred key->conversationId binding to the
// sidecar IF the session is still marked bindingPending AND the conversation
// file now exists on disk. Called from handleRunExit after the backend's final
// save. This is the second half of the phantom-binding fix: a freshly
// pre-minted session defers its binding at StartSession, and we persist it only
// once the conversation has actually been saved — so a session that started but
// never completed a turn (no file) leaves no binding for a later restart to
// resume into an empty conversation. Idempotent: clears bindingPending after a
// successful write so subsequent run exits don't rewrite it. (#230/#231)
func (m *Manager) flushPendingBinding(key, convID string) {
	if convID == "" {
		return
	}

	m.mu.Lock()
	s, ok := m.sessions[key]
	pending := ok && s.bindingPending
	m.mu.Unlock()

	if !pending {
		return
	}

	if !conversation.Exists(convID, "") {
		utils.Debug("Session", fmt.Sprintf("flushPendingBinding: key=%s conversationID=%s not yet saved — leaving binding deferred", key, convID))
		return
	}

	saveBinding(bindingsPath(), key, convID)

	m.mu.Lock()
	if s, ok := m.sessions[key]; ok {
		s.bindingPending = false
	}
	m.mu.Unlock()
	utils.Log("Session", fmt.Sprintf("flushPendingBinding: key=%s wrote deferred binding for conversationID=%s (file now present)", key, convID))
}

// resolveConversationID decides which conversation a StartSession should use,
// given the session key, the caller's config, and the durable binding store at
// `path`. The decision tree (first match wins):
//
//  1. Explicit config.SessionID — the caller named a conversation; use it
//     unconditionally. Highest precedence; bypasses all other checks. An
//     external consumer that supplies a SessionID is asserting the exact id —
//     the session may be brand-new (no backing file yet) or a genuine resume.
//     The phantom guard (require backing file) applies ONLY to stored bindings
//     (implicit resume, branch 3), not explicit caller assertions, because the
//     caller is the authoritative source of truth for its own ID.
//  2. config.ForceNewConversation — the caller wants a brand-new conversation
//     on this key even if a binding exists (e.g. the user clicked "new
//     conversation" on an existing tab). Mint a fresh id; the post-creation
//     saveBinding in StartSession REPLACES the stored binding, so the prior
//     conversation is no longer auto-resumed for this key. (#231)
//  3. A stored binding for this key — resume it rather than minting, IF a
//     backing file exists. This is what makes the engine resilient to restarts
//     even when the client does not carry the conversationId forward. A stored
//     binding pointing at a fileless phantom is ignored (it would resume empty),
//     falling through to a fresh mint. (B2 fix for issue #230; phantom guard #230/#231)
//  4. Nothing usable — pre-mint a fresh id (first-ever start for this key, or
//     every prior candidate was a fileless phantom).
//
// Existence is probed via conversation.Exists (cheap file-presence check, no
// parsing). Every branch logs which path was taken and why, so the
// session-identity decision is reconstructable from ~/.ion/engine.log without
// a debugger.
func resolveConversationID(path, key string, config types.EngineConfig) string {
	if config.SessionID != "" {
		// Caller-supplied SessionID is always honored unconditionally.
		// The "phantom guard" (require backing file) applies only to stored
		// bindings (implicit resume), not explicit caller assertions. An external
		// consumer that supplies a SessionID expects it threaded through to
		// RunOptions regardless of whether a conversation file exists yet —
		// the session may be brand-new and the file will be created on first run.
		// Requiring conversation.Exists here broke TestStartSessionWithSessionID
		// (regression from #256) by falling through to a fresh mint whenever
		// the named ID had no backing file. (#256 fix)
		utils.Log("Session", fmt.Sprintf("StartSession: key=%s using explicit conversationID=%s (caller-supplied, unconditional)", key, config.SessionID))
		return config.SessionID
	}
	if config.ForceNewConversation {
		old := lookupBinding(path, key)
		// Remove the stale binding eagerly so the prior conversation is no
		// longer auto-resumed for this key, even though the freshly minted
		// conversation's own binding is deferred until its first save. Without
		// this, a restart between force-new and first save would resume the old
		// conversation. (#231)
		deleteBinding(path, key)
		convID := conversation.NewConversationID()
		utils.Log("Session", fmt.Sprintf("StartSession: key=%s forced new conversation, cleared stale binding old=%s new=%s (new binding deferred until save)", key, old, convID))
		return convID
	}
	if bound := lookupBinding(path, key); bound != "" {
		if conversation.Exists(bound, "") {
			utils.Log("Session", fmt.Sprintf("StartSession: key=%s resuming bound conversationID=%s from binding store (file present)", key, bound))
			return bound
		}
		// Stored binding points at a fileless phantom (a prior pre-mint that was
		// never saved). Ignore it rather than resuming empty.
		utils.Log("Session", fmt.Sprintf("StartSession: key=%s bound conversationID=%s has NO backing file — ignoring phantom binding, minting fresh", key, bound))
	}
	convID := conversation.NewConversationID()
	utils.Log("Session", fmt.Sprintf("StartSession: key=%s pre-minted conversationID=%s (no usable binding)", key, convID))
	return convID
}
