package session

import (
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
// the watcher does not spend inotify watches on them on Linux, or deliver
// their event storms on every platform. Editor swap and tmp files round out the list because they are
// universally noisy.
//
// Every pattern carries the `**/` prefix so it matches AT ANY DEPTH, not just
// at the watcher root. doublestar's `**/` matches zero or more path segments,
// so `**/node_modules/**` matches both a root-level `node_modules/x` and a
// nested `desktop/node_modules/x`. The root-anchored form (`node_modules/**`)
// was a production defect: in a monorepo, nested node_modules trees were
// watched, and one npm ci storm (delete + recreate of ~60k files) exhausted
// the engine's fd table on macOS, which then watched with kqueue and held an
// fd per watched file, and starved every session in the process of pipes and
// sockets.
//
// Harness engineers who need different behavior (e.g. watching node_modules
// for a dependency-debugging extension, or excluding a custom build dir)
// override the whole list via EngineConfig.WorkspaceWatchIgnore. The
// override REPLACES the defaults -- it does not merge -- so the override
// gives full control. A future additive field could layer on top if
// merge-style override turns out to be useful.
var defaultWatchIgnores = []string{
	"**/.git/**",
	"**/node_modules/**",
	"**/dist/**",
	"**/build/**",
	"**/target/**",
	"**/.next/**",
	"**/.nuxt/**",
	"**/.venv/**",
	"**/__pycache__/**",
	"**/.ion/**",
	"**/.DS_Store",
	"**/*.swp",
	"**/*.swo",
	"**/*.tmp",
	"**/*~",
}

// resolveWatchIgnores returns the effective ignore list for a given config:
// the harness override when non-empty, otherwise the engine defaults.
func resolveWatchIgnores(cfg types.EngineConfig) []string {
	if len(cfg.WorkspaceWatchIgnore) > 0 {
		return cfg.WorkspaceWatchIgnore
	}
	return defaultWatchIgnores
}

// ensureWorkspaceWatcher starts the session's workspace watcher unless it
// already has one. Safe to call more than once for a session: a session that
// starts without extensions and gains them later keeps the watcher it has.
func (m *Manager) ensureWorkspaceWatcher(s *engineSession, key string) {
	m.mu.RLock()
	running := s.fsWatcherRelease != nil
	m.mu.RUnlock()
	if running {
		return
	}
	release := m.startWorkspaceWatcher(s, key)
	if release == nil {
		return
	}
	m.mu.Lock()
	if s.fsWatcherRelease != nil {
		// Another caller started one in the meantime; keep theirs.
		m.mu.Unlock()
		release()
		return
	}
	s.fsWatcherRelease = release
	m.mu.Unlock()
}

// sessionExtGroup returns the session's extension group, or nil when it has
// none loaded.
func (m *Manager) sessionExtGroup(s *engineSession) *extension.ExtensionGroup {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s.extGroup == nil || s.extGroup.IsEmpty() {
		return nil
	}
	return s.extGroup
}

// startWorkspaceWatcher acquires a shared watcher from the Manager's pool
// for this session's working directory. Returns a release function (or nil
// when no watcher should run). Multiple sessions on the same directory
// share one underlying filesystem watcher rather than one each.
//
// A watcher has two consumers: extensions, which receive the workspace hooks,
// and wiki-link maintenance, which is an engine feature and needs renames
// observed whether or not any extension is loaded. With neither, no watcher
// runs.
func (m *Manager) startWorkspaceWatcher(s *engineSession, key string) func() {
	links := m.resolveWikiLinkSettings()
	if !links.enabled && m.sessionExtGroup(s) == nil {
		utils.LogWithFields(utils.LevelDebug, "session", "startworkspacewatcher: skip reason=no_extensions_and_wiki_links_disabled", map[string]any{"key": key})
		return nil
	}
	if s.config.WorkingDirectory == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "startworkspacewatcher: skip reason=empty_working_directory", map[string]any{"key": key})
		return nil
	}

	// Skip watcher when the working directory IS the engine's own data
	// directory (~/.ion). The default ignore pattern ".ion/**" is relative to
	// the watcher root, so it only works when the root is a *parent* of
	// ~/.ion. When the root IS ~/.ion, every engine-internal file change
	// (logs, conversations, sockets, state files) triggers watcher events —
	// a feedback loop that generates hundreds of thousands of spurious log
	// lines per log rotation and wastes CPU.
	if ionHomeRaw := utils.IonDir(); ionHomeRaw != "" {
		ionHome := filepath.Clean(ionHomeRaw)
		cwdClean := filepath.Clean(s.config.WorkingDirectory)
		if cwdClean == ionHome {
			utils.LogWithFields(utils.LevelInfo, "session", "startworkspacewatcher: skip reason=working_directory_is_ion_home", map[string]any{"key": key, "cwd_clean": cwdClean})
			return nil
		}
	}

	ignores := resolveWatchIgnores(s.config)
	source := "default"
	if len(s.config.WorkspaceWatchIgnore) > 0 {
		source = "harness_override"
	}
	if source == "harness_override" {
		utils.LogWithFields(utils.LevelDebug, "session", "startworkspacewatcher: harness override patterns", map[string]any{"key": key, "ignores": ignores})
	}

	// The extension group is looked up per event rather than captured: a
	// session can gain extensions after its watcher started.
	onEvent := func(info watcher.Info) {
		group := m.sessionExtGroup(s)
		if group == nil {
			return
		}
		ctx := m.newExtContext(s, key)
		if info.Action == watcher.ActionRename {
			group.FireWorkspaceFileRenamed(ctx, extension.WorkspaceFileRenamedInfo{
				OldPath:    info.OldPath,
				OldRelPath: info.OldRelPath,
				NewPath:    info.Path,
				NewRelPath: info.RelPath,
			})
			return
		}
		group.FireWorkspaceFileChanged(ctx, extension.WorkspaceFileChangedInfo{
			Path:    info.Path,
			RelPath: info.RelPath,
			Action:  info.Action,
		})
	}

	// One typed event per session, then the observe-only hook. The report is
	// the complete record of the pass; nothing else carries it.
	onPropagated := func(report types.WikiLinkPropagationReport) {
		utils.LogWithFields(utils.LevelInfo, "session.wikilinks", "propagation report delivered", map[string]any{
			"key": key, "root": report.Root, "renames": len(report.Renames), "files": len(report.Files), "rewrites": report.RewriteCount, "failed": len(report.Failed),
		})
		m.emit(key, types.EngineEvent{Type: "engine_wiki_links_propagated", WikiLinksPropagated: &report})
		if group := m.sessionExtGroup(s); group != nil {
			group.FireWikiLinksPropagated(m.newExtContext(s, key), report)
		}
	}

	// Resolve the configurable per-watcher directory cap from engine config.
	// Nil-safe: MaxWatchedDirsOr returns the watcher package default for a nil
	// Workspace block, and watcher.NewWithMaxDirs treats zero as "use default"
	// — so an unset config still yields the compiled default.
	maxDirs := 0
	if m.config != nil {
		maxDirs = m.config.GetWorkspace().MaxWatchedDirsOr()
	}

	release, err := m.watchers.acquire(s.config.WorkingDirectory, ignores, key, maxDirs, links, watchSubscriber{onEvent: onEvent, onPropagated: onPropagated})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "session", "startworkspacewatcher: acquire failed", map[string]any{"key": key, "working_directory": s.config.WorkingDirectory, "error": err})
		return nil
	}

	utils.LogWithFields(utils.LevelInfo, "session", "startworkspacewatcher: acquired", map[string]any{"key": key, "working_directory": s.config.WorkingDirectory, "count": len(ignores), "source": source})
	return release
}
