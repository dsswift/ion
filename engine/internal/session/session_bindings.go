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

// resolveConversationID decides which conversation a StartSession should use,
// given the session key, the caller's config, and the durable binding store at
// `path`. The decision tree (first match wins):
//
//  1. Explicit config.SessionID — the caller named a conversation; use it
//     verbatim. Highest precedence; bypasses the binding store entirely. The
//     caller (re-register / resume path) is asserting the exact id.
//  2. config.ForceNewConversation — the caller wants a brand-new conversation
//     on this key even if a binding exists (e.g. the user clicked "new
//     conversation" on an existing tab). Mint a fresh id; the post-creation
//     saveBinding in StartSession REPLACES the stored binding, so the prior
//     conversation is no longer auto-resumed for this key. (#231)
//  3. A stored binding for this key — resume it rather than minting. This is
//     what makes the engine resilient to restarts even when the client does not
//     carry the conversationId forward. (B2 fix for issue #230)
//  4. Nothing stored — pre-mint a fresh id (first-ever start for this key).
//
// Every branch logs which path was taken and why, so the session-identity
// decision is reconstructable from ~/.ion/engine.log without a debugger.
func resolveConversationID(path, key string, config types.EngineConfig) string {
	if config.SessionID != "" {
		return config.SessionID
	}
	if config.ForceNewConversation {
		old := lookupBinding(path, key)
		convID := conversation.NewConversationID()
		utils.Log("Session", fmt.Sprintf("StartSession: key=%s forced new conversation, replaced binding old=%s new=%s", key, old, convID))
		return convID
	}
	if bound := lookupBinding(path, key); bound != "" {
		utils.Log("Session", fmt.Sprintf("StartSession: key=%s resuming bound conversationID=%s from binding store", key, bound))
		return bound
	}
	convID := conversation.NewConversationID()
	utils.Log("Session", fmt.Sprintf("StartSession: key=%s pre-minted conversationID=%s (no binding found)", key, convID))
	return convID
}
