// prompt_queue.go — prompt queue management for busy sessions.
//
// enqueueIfBusy is the gating helper called by SendPrompt when the session
// already has an in-flight run. It value-copies the PromptOverrides so
// per-prompt flags survive the queue round-trip intact.

package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// enqueueIfBusy queues the prompt onto a running session. Returns
// (queueFull, err): when queueFull the caller emits the error event after
// dropping the lock; when err is nil the prompt was queued successfully.
// Caller must hold m.mu.
func (m *Manager) enqueueIfBusy(s *engineSession, key, text string, overrides *PromptOverrides) (bool, error) {
	if len(s.promptQueue) >= s.maxQueueDepth {
		return true, fmt.Errorf("session %q prompt queue full (%d)", key, s.maxQueueDepth)
	}
	pp := pendingPrompt{text: text}
	if overrides != nil {
		// Value-copy all 19 PromptOverrides fields so every per-prompt flag
		// (ResolveSlash, BashAllowlistAdditionsForThisPrompt, PlanFilePath,
		// CompactEnabled, harness prose, etc.) survives the queue round-trip
		// intact. The caller may free or reuse its pointer after this returns;
		// the copy in the queue is independent.
		ovCopy := *overrides
		pp.overrides = &ovCopy
	}
	s.promptQueue = append(s.promptQueue, pp)
	utils.LogWithFields(utils.LevelInfo, "session", "prompt queued for ( in queue)", map[string]any{"key": key, "count": len(s.promptQueue)})
	return false, nil
}
