package backend

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// persistInitialDeliveryEntries appends the queued completion entries and the
// run-opening user prompt, saves them as one durable batch, and emits delivery
// events only after that save succeeds. It returns the canonical entry ID for
// the run-opening prompt.
func (b *ApiBackend) persistInitialDeliveryEntries(run *activeRun, conv *conversation.Conversation, opts *types.RunOptions) string {
	// Queue-mode completions are first-class durable conversation inputs, not
	// ephemeral initial messages. They precede this run's opening prompt, which
	// is their real causal order, and each delivery event is emitted after Save.
	pendingBackgroundEntries := make([]string, 0, len(opts.PendingBackgroundWork))
	for _, delivery := range opts.PendingBackgroundWork {
		entry := conversation.AddUserMessageWithBackgroundWork(conv, delivery.Content, delivery.Work)
		if entry != nil {
			pendingBackgroundEntries = append(pendingBackgroundEntries, entry.ID)
		}
	}

	// Append the inbound user turn. The engine does not echo this turn back to
	// clients. The persisted turn is the snapshot authority for all consumers.
	var userEntry *conversation.SessionEntry
	if opts.PrePersistedUserEntryID == "" {
		userEntry = AppendInboundUserMessage(conv, opts)
	} else {
		userEntry = &conversation.SessionEntry{ID: opts.PrePersistedUserEntryID}
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "reusing session-persisted user turn", map[string]any{
			"run_id": run.requestID, "entry_id": opts.PrePersistedUserEntryID,
		})
	}

	// Persist the queued completions and the run-opening prompt together. No
	// delivery event is emitted until this save succeeds, so consumers never
	// receive a completion that history cannot reproduce after a restart.
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation after AddUserMessage", map[string]any{
			"error": utils.ErrStr(err),
		})
	} else {
		if opts.BackgroundWork != nil && userEntry != nil {
			b.emit(run, types.NormalizedEvent{Data: &types.BackgroundWorkDeliveredEvent{
				EntryID: userEntry.ID, Content: opts.Prompt, Work: *opts.BackgroundWork,
			}})
		}
		for index, delivery := range opts.PendingBackgroundWork {
			entryID := ""
			if index < len(pendingBackgroundEntries) {
				entryID = pendingBackgroundEntries[index]
			}
			b.emit(run, types.NormalizedEvent{Data: &types.BackgroundWorkDeliveredEvent{
				EntryID: entryID, Content: delivery.Content, Work: delivery.Work,
			}})
		}
	}

	if userEntry == nil {
		return ""
	}
	return userEntry.ID
}
