package session

import "github.com/dsswift/ion/engine/internal/utils"

// dispatchQueuedPrompt re-submits a dequeued prompt on its own goroutine,
// forwarding the full *PromptOverrides captured at enqueue time. Every override
// field survives the queue round-trip because enqueueIfBusy stored
// a value copy. Dispatched off-lock and on a goroutine because SendPrompt
// re-acquires m.mu and may start a run.
func (m *Manager) dispatchQueuedPrompt(key string, next *pendingPrompt) {
	go func() {
		if err := m.SendPrompt(key, next.text, next.overrides); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "queued prompt failed", map[string]any{"error": err.Error()})
		}
	}()
}
