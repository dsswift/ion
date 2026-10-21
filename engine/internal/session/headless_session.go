// headless_session.go — the session an engine host's fire runs in.
//
// A session host's schedule or webhook fires into the conversation the host
// is bound to. An engine host (engine_hosts.go) has no conversation, so the
// async resolver mints one per fire: a real session with its own conversation
// on disk, the session-scoped extensions loaded, hooks and tools working, and
// the run-as principal stamped on everything. No client ever subscribes to it.
// When the fire's work is done, idle release (idle_release.go) stops it after
// the short headless window.
package session

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const headlessLogTag = "session.headless"

// headlessKeyPrefix marks a headless session key. Clients mint their own keys
// and never this prefix, so the prefix alone says who made the session.
const headlessKeyPrefix = "headless:"

// mintHeadlessSession starts a fresh session for one of host's fires and
// returns the extension context the fire runs under.
func (m *Manager) mintHeadlessSession(host *extension.Host) (*extension.Context, error) {
	m.mu.RLock()
	cfg := m.config
	principal := m.runAsPrincipal
	m.mu.RUnlock()
	if cfg == nil || cfg.ExtensionHosts == nil {
		return nil, fmt.Errorf("headless session for %s: no extensionHosts config", host.Name())
	}
	template := cfg.ExtensionHosts.Session
	key := fmt.Sprintf("%s%s:%d", headlessKeyPrefix, extensionLabel(host), time.Now().UnixNano())
	config := types.EngineConfig{
		ProfileID:            template.ProfileID,
		Extensions:           cfg.ExtensionHosts.SessionExtensions(),
		WorkingDirectory:     template.WorkingDirectory,
		Model:                template.Model,
		ForceNewConversation: true,
	}
	var principalCopy *types.SessionPrincipal
	if principal != nil {
		p := *principal
		principalCopy = &p
	}
	utils.LogWithFields(utils.LevelInfo, headlessLogTag, "minting headless session", map[string]any{"key": key, "extension": host.Name(), "working_directory": config.WorkingDirectory, "count": len(config.Extensions), "run_as": principalSubject(principalCopy)})
	result, err := m.startSession(key, config, principalCopy, nil, nil)
	if err != nil {
		utils.LogWithFields(utils.LevelError, headlessLogTag, "headless session start failed", map[string]any{"key": key, "extension": host.Name(), "error": err.Error()})
		return nil, fmt.Errorf("headless session for %s: %w", host.Name(), err)
	}
	m.mu.Lock()
	s, ok := m.sessions[key]
	if ok {
		s.headless = true
	}
	m.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("headless session %q vanished after start", key)
	}
	utils.LogWithFields(utils.LevelInfo, headlessLogTag, "headless session started", map[string]any{"key": key, "conversation_id": result.ConversationID, "storage_root": result.StorageRoot, "extension": host.Name()})
	return m.newExtContext(s, key), nil
}

// IsHeadlessKey reports whether a session key names an engine-minted session.
func IsHeadlessKey(key string) bool {
	return len(key) > len(headlessKeyPrefix) && key[:len(headlessKeyPrefix)] == headlessKeyPrefix
}
