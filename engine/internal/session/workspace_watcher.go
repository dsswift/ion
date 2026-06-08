package session

import (
	"fmt"
	"os"
	"path/filepath"

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

// startWorkspaceWatcher acquires a shared watcher from the Manager's pool
// for this session's working directory. Returns a release function (or nil
// when no watcher should run). Multiple sessions on the same directory
// share one underlying filesystem watcher, avoiding file-descriptor
// exhaustion on macOS where kqueue requires one FD per watched directory.
func (m *Manager) startWorkspaceWatcher(s *engineSession, key string, group *extension.ExtensionGroup) func() {
	if group == nil || group.IsEmpty() {
		utils.Debug("session", fmt.Sprintf("startWorkspaceWatcher: skip key=%s reason=no_extensions", key))
		return nil
	}
	if s.config.WorkingDirectory == "" {
		utils.Debug("session", fmt.Sprintf("startWorkspaceWatcher: skip key=%s reason=empty_working_directory", key))
		return nil
	}

	// Skip watcher when the working directory IS the engine's own data
	// directory (~/.ion). The default ignore pattern ".ion/**" is relative to
	// the watcher root, so it only works when the root is a *parent* of
	// ~/.ion. When the root IS ~/.ion, every engine-internal file change
	// (logs, conversations, sockets, state files) triggers watcher events —
	// a feedback loop that generates hundreds of thousands of spurious log
	// lines per log rotation and wastes CPU.
	if home, err := os.UserHomeDir(); err == nil {
		ionHome := filepath.Clean(filepath.Join(home, ".ion"))
		cwdClean := filepath.Clean(s.config.WorkingDirectory)
		if cwdClean == ionHome {
			utils.Info("session", fmt.Sprintf("startWorkspaceWatcher: skip key=%s reason=working_directory_is_ion_home cwd=%s", key, cwdClean))
			return nil
		}
	}

	ignores := resolveWatchIgnores(s.config)
	source := "default"
	if len(s.config.WorkspaceWatchIgnore) > 0 {
		source = "harness_override"
	}
	if source == "harness_override" {
		utils.Debug("session", fmt.Sprintf("startWorkspaceWatcher: harness override patterns key=%s patterns=%v", key, ignores))
	}

	onEvent := func(info watcher.Info) {
		ctx := m.newExtContext(s, key)
		group.FireWorkspaceFileChanged(ctx, extension.WorkspaceFileChangedInfo{
			Path:    info.Path,
			RelPath: info.RelPath,
			Action:  info.Action,
		})
	}

	release, err := m.watchers.acquire(s.config.WorkingDirectory, ignores, key, onEvent)
	if err != nil {
		utils.Error("session", fmt.Sprintf("startWorkspaceWatcher: acquire failed key=%s cwd=%s err=%v", key, s.config.WorkingDirectory, err))
		return nil
	}

	utils.Info("session", fmt.Sprintf("startWorkspaceWatcher: acquired key=%s cwd=%s ignore_count=%d ignore_source=%s", key, s.config.WorkingDirectory, len(ignores), source))
	return release
}
