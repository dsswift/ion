package session

import (
	"os"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/recorder"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// stoppedSessionResources are captured under Manager.mu and released only
// after the session disappears from the map. None of these operations may run
// under Manager.mu because they can wait on subprocesses or filesystem work.
type stoppedSessionResources struct {
	extGroup          *extension.ExtensionGroup
	mcpConns          []*mcp.Connection
	telemetry         *telemetry.Collector
	recorder          *recorder.Recorder
	toolServer        *backend.ToolServer
	fsWatcherRelease  func()
	sessionMemory     *SessionMemory
	hookSettingsPath  string
	purgeExtensionDir string
	conversationID    string
	key               string
	session           *engineSession
}

func (m *Manager) finishStoppedSession(resources stoppedSessionResources) {
	m.handleStopRecovery(resources.conversationID, resources.key)
	if resources.purgeExtensionDir != "" {
		m.runOnce.purgeExtension(resources.purgeExtensionDir)
	}
	tools.StopBackgroundTasksForOwner(resources.key)
	m.clearOutstandingBackgroundTasks(resources.key)
	if resources.sessionMemory != nil {
		resources.sessionMemory.Stop()
	}
	if resources.toolServer != nil {
		resources.toolServer.Stop()
	}
	if resources.hookSettingsPath != "" {
		if err := os.Remove(resources.hookSettingsPath); err != nil && !os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelWarn, "session", "failed to remove hook settings file", map[string]any{"path": resources.hookSettingsPath, "error": err.Error()})
		}
	}
	if resources.fsWatcherRelease != nil {
		resources.fsWatcherRelease()
		utils.LogWithFields(utils.LevelInfo, "session", "stopsession: released watcher", map[string]any{"key": resources.key})
	}
	if resources.extGroup != nil && !resources.extGroup.IsEmpty() {
		ctx := m.newExtContext(resources.session, resources.key)
		resources.extGroup.FireSessionEnd(ctx) //nolint:errcheck // errors logged internally by fireVoid/s.fire
		for _, host := range resources.extGroup.Hosts() {
			m.unwireHostAsync(host)
		}
		resources.extGroup.Close()
	}
	for _, conn := range resources.mcpConns {
		conn.Close() //nolint:errcheck // resource close
	}
	if resources.telemetry != nil {
		resources.telemetry.Close()
	}
	if resources.recorder != nil {
		resources.recorder.Close() //nolint:errcheck // resource close
	}
	m.emit(resources.key, types.EngineEvent{Type: "engine_dead"})
}
