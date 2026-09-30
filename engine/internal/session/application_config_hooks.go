package session

import (
	"github.com/dsswift/ion/engine/internal/appconfig"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// WatchApplicationConfig forwards every application config transition to
// the extensions of every live session that declares
// application_config_changed. Call it before the store starts so the first
// transition is not missed; the returned func stops forwarding.
func (m *Manager) WatchApplicationConfig() (stop func()) {
	return appconfig.Subscribe(m.handleApplicationConfigChange)
}

func (m *Manager) handleApplicationConfigChange(snapshot appconfig.Snapshot) {
	type target struct {
		session *engineSession
		key     string
		group   *extension.ExtensionGroup
	}
	m.mu.RLock()
	targets := make([]target, 0, len(m.sessions))
	for key, s := range m.sessions {
		targets = append(targets, target{session: s, key: key, group: s.extGroup})
	}
	m.mu.RUnlock()
	for _, t := range targets {
		if t.group == nil || t.group.IsEmpty() {
			continue
		}
		for _, host := range t.group.Hosts() {
			if !host.DeclaresHook(extension.HookApplicationConfigChanged) {
				continue
			}
			ctx := m.newExtContext(t.session, t.key)
			// A session acting as its own principal sees only that
			// principal's view; every other session sees the process view.
			subject := ""
			if ctx.Identity != nil {
				subject = ctx.Identity.Subject
			}
			view := snapshot.For(subject)
			fields := map[string]any{"session_id": t.key, "extension": host.Name(), "state": view.State, "revision": view.Revision}
			if err := host.FireApplicationConfigChanged(ctx, view); err != nil {
				fields["error"] = err.Error()
				utils.LogWithFields(utils.LevelWarn, "session.appconfig", "application config hook failed", fields)
				continue
			}
			utils.LogWithFields(utils.LevelInfo, "session.appconfig", "application config hook applied", fields)
		}
	}
}
