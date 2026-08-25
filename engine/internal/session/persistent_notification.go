package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// wirePersistentNotification preserves ctx.Notify for extension callbacks that
// finish after their hook, tool, schedule, or dispatch context frame exits.
func wirePersistentNotification(host *extension.Host, manager *Manager, session *engineSession, key string) {
	host.SetPersistentNotify(func(opts types.NotifyOpts) error {
		if opts.Title == "" {
			return fmt.Errorf("notification title is required")
		}
		(&sessionAccessor{m: manager, s: session, key: key}).BroadcastNotification(opts)
		return nil
	})
}
