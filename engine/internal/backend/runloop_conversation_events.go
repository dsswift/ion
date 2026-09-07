package backend

import "github.com/dsswift/ion/engine/internal/types"

// announceUserTurnPersisted emits UserTurnPersistedEvent, announcing the
// persisted user turn's canonical entry id NOW — before any streaming — so
// consumers can re-key their optimistic user row immediately. message_end
// carries the same id (UserEntryID), but a run that is cancelled or fails
// mid-stream never reaches a message_end, and the un-re-keyed optimistic row
// then duplicates against the persisted turn on the next history load. This
// emission covers every run outcome. Re-key signal only: id, never content
// (the engine does not echo user turns — see the comment above
// appendInboundUserMessage).
func (b *ApiBackend) announceUserTurnPersisted(run *activeRun, opts types.RunOptions, runUserEntryID string) {
	if runUserEntryID == "" {
		return
	}
	b.emit(run, types.NormalizedEvent{Data: &types.UserTurnPersistedEvent{
		EntryID:             runUserEntryID,
		SlashModelAlias:     opts.ResolvedSlashModelAlias,
		SlashModelEffective: opts.ResolvedSlashModelEffective,
		SlashFrontmatter:    opts.ResolvedSlashFrontmatter,
	}})
}

// runloop_conversation_events.go extracts the two conversation.* telemetry
// delivery call sites out of runloop.go (which is otherwise at the 800-line
// file-size cap) into their own file.

// deliverConversationUserMessage delivers the run-opening user turn's raw
// text to the conversation.* telemetry seam (RunConfig.OnUserMessage) right
// before runloop.go emits the UserTurnPersistedEvent wire event, so it fires
// exactly once per persisted user turn and stays correlated with the SAME
// entry id the wire event carries. Nil-safe: OnUserMessage is nil until the
// session-layer wiring attaches it, and delegated-CLI backends never carry a
// RunConfig here at all.
func deliverConversationUserMessage(run *activeRun, runUserEntryID, prompt string) {
	if runUserEntryID != "" && run.cfg != nil && run.cfg.OnUserMessage != nil {
		run.cfg.OnUserMessage(runUserEntryID, prompt)
	}
}

// deliverConversationAssistantMessage delivers one completed assistant
// message's raw text to the conversation.* telemetry seam
// (RunConfig.OnAssistantMessage), from the SAME code block that just
// delivered OnCallCost — so the paired UsageEvent runloop.go emits next can
// attach both without re-deriving either.
func deliverConversationAssistantMessage(run *activeRun, model string, assistantBlocks []types.LlmContentBlock) {
	if len(assistantBlocks) > 0 && run.cfg != nil && run.cfg.OnAssistantMessage != nil {
		run.cfg.OnAssistantMessage(model, assistantTextForTelemetry(assistantBlocks))
	}
}
