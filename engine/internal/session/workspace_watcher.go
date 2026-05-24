package session

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/watcher"
)

// defaultWatchIgnores is the engine's built-in list of glob patterns that the
// workspace_file_changed watcher skips when EngineConfig.WorkspaceWatchIgnore
// is empty. The list targets the directories most repos generate large
// amounts of churn in (.git, node_modules, build outputs, virtualenvs) so
// the watcher does not exhaust inotify descriptors on Linux or burn CPU on
// macOS FSEvents storms during npm install / cargo build / etc. Editor swap
// and tmp files round out the list because they are universally noisy.
//
// Harness engineers who need different behavior (e.g. watching node_modules
// for a dependency-debugging extension, or excluding a custom build dir)
// override the whole list via EngineConfig.WorkspaceWatchIgnore. The
// override REPLACES the defaults -- it does not merge -- so the override
// gives full control. A future additive field could layer on top if
// merge-style override turns out to be useful.
var defaultWatchIgnores = []string{
	".git/**",
	"node_modules/**",
	"dist/**",
	"build/**",
	"target/**",
	".next/**",
	".nuxt/**",
	".venv/**",
	"__pycache__/**",
	".ion/**",
	".DS_Store",
	"*.swp",
	"*.swo",
	"*.tmp",
	"*~",
}

// resolveWatchIgnores returns the effective ignore list for a given config:
// the harness override when non-empty, otherwise the engine defaults.
func resolveWatchIgnores(cfg types.EngineConfig) []string {
	if len(cfg.WorkspaceWatchIgnore) > 0 {
		return cfg.WorkspaceWatchIgnore
	}
	return defaultWatchIgnores
}

// startWorkspaceWatcher constructs and starts the session-scoped fsnotify
// watcher. Logs start / skip / failure outcomes and returns the live watcher
// (or nil when the watcher should not run for this session).
//
// Skip conditions: no extension group loaded (nothing to fire hooks into),
// empty WorkingDirectory (no root to watch). Failure to construct or start
// is logged but does not propagate -- the session is still usable without
// workspace file events.
func (m *Manager) startWorkspaceWatcher(s *engineSession, key string, group *extension.ExtensionGroup) *watcher.Watcher {
	if group == nil || group.IsEmpty() {
		utils.Debug("session", fmt.Sprintf("startWorkspaceWatcher: skip key=%s reason=no_extensions", key))
		return nil
	}
	if s.config.WorkingDirectory == "" {
		utils.Debug("session", fmt.Sprintf("startWorkspaceWatcher: skip key=%s reason=empty_working_directory", key))
		return nil
	}

	ignores := resolveWatchIgnores(s.config)
	source := "default"
	if len(s.config.WorkspaceWatchIgnore) > 0 {
		source = "harness_override"
	}

	w, err := watcher.New(s.config.WorkingDirectory, ignores)
	if err != nil {
		utils.Error("session", fmt.Sprintf("startWorkspaceWatcher: New failed key=%s cwd=%s err=%v", key, s.config.WorkingDirectory, err))
		return nil
	}

	onEvent := func(info watcher.Info) {
		// Rebuild the extension context per event so the callback always
		// sees the current session state (mirrors how every other engine
		// -> extension fan-out builds context fresh per call).
		ctx := m.newExtContext(s, key)
		group.FireWorkspaceFileChanged(ctx, extension.WorkspaceFileChangedInfo{
			Path:    info.Path,
			RelPath: info.RelPath,
			Action:  info.Action,
		})
	}

	if err := w.Start(context.Background(), onEvent); err != nil {
		utils.Error("session", fmt.Sprintf("startWorkspaceWatcher: Start failed key=%s cwd=%s err=%v", key, s.config.WorkingDirectory, err))
		// Best-effort cleanup of whatever the constructor allocated.
		_ = w.Close()
		return nil
	}

	utils.Info("session", fmt.Sprintf("startWorkspaceWatcher: started key=%s cwd=%s ignore_count=%d ignore_source=%s", key, s.config.WorkingDirectory, len(ignores), source))
	return w
}

// stopWorkspaceWatcher tears down the session's filesystem watcher, if any.
// Idempotent and safe on a nil watcher. Called from the session-stop path
// before the extension group is closed so any in-flight watcher callbacks
// drain into a still-live group.
func stopWorkspaceWatcher(key string, w *watcher.Watcher) {
	if w == nil {
		utils.Debug("session", fmt.Sprintf("stopWorkspaceWatcher: skip key=%s reason=nil_watcher", key))
		return
	}
	if err := w.Close(); err != nil {
		utils.Error("session", fmt.Sprintf("stopWorkspaceWatcher: Close failed key=%s err=%v", key, err))
		return
	}
	utils.Info("session", fmt.Sprintf("stopWorkspaceWatcher: stopped key=%s", key))
}
