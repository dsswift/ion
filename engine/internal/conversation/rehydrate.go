package conversation

// rehydrateMessageUsage assigns Usage pointers from the entry tree onto the
// corresponding assistant messages in conv.Messages. It is called once at load
// time (by loadSplit and loadFromJSONL) so that GetContextUsage can perform its
// backward scan without needing the legacy LastInputTokens scalar.
//
// The matching is by order-of-appearance: the k-th assistant entry with non-nil
// Usage corresponds to the k-th assistant message in conv.Messages. Both lists
// are in chronological order (BuildContextPath emits messages in path order;
// entries are appended in order), so a single forward pass suffices.
//
// Entries without Usage (user messages, non-message entries) are skipped.
// Messages that have no corresponding entry (e.g. legacy conversations that
// predate Usage tracking on entries) keep Usage == nil and fall through to the
// heuristic path in GetContextUsage.
func rehydrateMessageUsage(conv *Conversation) {
	if len(conv.Messages) == 0 || len(conv.Entries) == 0 {
		return
	}

	// Collect assistant entries with non-nil Usage, in path order.
	pathEntries := getContextPathEntries(conv)
	var assistantUsages []MessageData
	for _, e := range pathEntries {
		if e.Type != EntryMessage {
			continue
		}
		md := asMessageData(e.Data)
		if md == nil || md.Role != "assistant" || md.Usage == nil {
			continue
		}
		assistantUsages = append(assistantUsages, *md)
	}

	if len(assistantUsages) == 0 {
		return
	}

	// Match by position: k-th assistant message gets k-th assistant entry's Usage.
	k := 0
	for i := range conv.Messages {
		if conv.Messages[i].Role != "assistant" {
			continue
		}
		if k >= len(assistantUsages) {
			break
		}
		conv.Messages[i].Usage = assistantUsages[k].Usage
		k++
	}
}
