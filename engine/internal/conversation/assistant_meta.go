package conversation

// SetAssistantMeta annotates the most recent assistant entry with model and
// stop reason metadata. This is called after AddAssistantMessage so callers
// that don't need metadata don't have to change.
func SetAssistantMeta(conv *Conversation, model, stopReason string) {
	conv.lock()
	defer conv.unlock()
	if conv.Entries == nil {
		return
	}
	// Walk backwards to find the last assistant entry.
	for i := len(conv.Entries) - 1; i >= 0; i-- {
		if conv.Entries[i].Type != EntryMessage {
			continue
		}
		md := asMessageData(conv.Entries[i].Data)
		if md == nil || md.Role != "assistant" {
			continue
		}
		md.Model = model
		md.StopReason = stopReason
		conv.Entries[i].Data = *md
		return
	}
}
