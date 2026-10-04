package session

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wirePermissionHookServer makes sure a claude-code run has its permission
// rail: a hook server the CLI consults before every tool call, so a
// hook-driven "ask" surfaces as engine_permission_request and blocks the
// subprocess until the user responds.
//
// One server per session, created on the first claude-code prompt and reused
// by every later one, then closed when the session stops. The settings file
// that points the CLI at it is written once alongside it.
//
// Under HybridBackend this only wires when the model resolves to the inner
// *ClaudeCodeBackend. API-routed runs use the in-process permission engine.
//
// A returned error means the run has no rail. The CLI is spawned under
// bypassPermissions, so a run without one would execute every tool call
// unchecked; the caller must not start it.
func (m *Manager) wirePermissionHookServer(s *engineSession, key string, opts *types.RunOptions, permEng *permissions.Engine) error {
	if _, isCli := m.resolvedBackend(opts.Model).(*backend.ClaudeCodeBackend); !isCli {
		return nil
	}
	if permEng == nil {
		return fmt.Errorf("permission rail: session %q has no permission engine", key)
	}

	m.mu.Lock()
	hookServer := s.permHookServer
	settingsPath := s.hookSettingsPath
	m.mu.Unlock()

	if hookServer != nil {
		// The session's engine can be replaced when its policy is re-resolved.
		hookServer.SetPermEngine(permEng)
		if m.config != nil {
			hookServer.SetTimeouts(m.config.Timeouts)
		}
		opts.HookSettingsPath = settingsPath
		utils.LogWithFields(utils.LevelDebug, "session", "permission hook server reused", map[string]any{"key": key, "port": hookServer.Port()})
		return nil
	}

	hookServer, err := backend.NewPermissionHookServer(permEng)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "session", "permissionhookserver start failed", map[string]any{"key": key, "error": err.Error()})
		return fmt.Errorf("permission rail: start hook server: %w", err)
	}
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		hookServer.Close()
		return fmt.Errorf("permission rail: generate token: %w", err)
	}
	token := hex.EncodeToString(tokenBytes)
	hookServer.RegisterToken(token)

	// Install the human-wait configuration so an unanswered permission dialog
	// waits indefinitely by default (and applies the configured fail-action
	// only when an operator sets a finite human-wait). A nil config yields the
	// indefinite default (the server-side accessors are nil-safe).
	if m.config != nil {
		hookServer.SetTimeouts(m.config.Timeouts)
	}

	// When the hook server gets an "ask" decision, emit
	// engine_permission_request and block until the user responds with an
	// option ID. The same closure serves the codex backend's approvals
	// (see wireCodexPermissions).
	hookServer.SetOnAsk(m.permissionAskClosure(key))

	settingsPath = filepath.Join(os.TempDir(), fmt.Sprintf("ion-settings-%s.json", token))
	if err := os.WriteFile(settingsPath, hookServer.GenerateSettingsJSON(token), 0600); err != nil {
		utils.LogWithFields(utils.LevelError, "session", "failed to write hook settings", map[string]any{"key": key, "error": err.Error()})
		hookServer.Close()
		return fmt.Errorf("permission rail: write hook settings: %w", err)
	}

	m.mu.Lock()
	s.permHookServer = hookServer
	s.hookSettingsPath = settingsPath
	m.mu.Unlock()
	opts.HookSettingsPath = settingsPath
	utils.LogWithFields(utils.LevelInfo, "session", "permission hook server started", map[string]any{"key": key, "port": hookServer.Port(), "settings_path": settingsPath})
	return nil
}

// abortPromptWithoutRail ends a prompt that cannot be given its permission
// rail: it releases the run identity, tells the consumer why, and returns the
// error for the caller to propagate. The session stays idle and usable.
func (m *Manager) abortPromptWithoutRail(s *engineSession, key, requestID string, overrides *PromptOverrides, railErr error) error {
	m.mu.Lock()
	s.clearRunIdentityFor(requestID)
	m.unbindRunLocked(requestID)
	m.mu.Unlock()
	m.ReleaseDeliveryID(key, deliveryIDFromOverrides(overrides))
	utils.LogWithFields(utils.LevelError, "session", "prompt refused: permission rail unavailable", map[string]any{
		"key": key, "run_id": requestID, "error": railErr.Error(),
	})
	m.emit(key, types.EngineEvent{
		Type:         "engine_error",
		EventMessage: "Ion could not start the permission check for this run, so the prompt was not sent: " + railErr.Error(),
		ErrorCode:    "permission_rail_unavailable",
	})
	return railErr
}
