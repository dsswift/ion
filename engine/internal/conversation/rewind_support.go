package conversation

// rewind_support.go — helpers backing the engine's ordinal-addressed,
// tree-native rewind (Manager.RewindSession). Clients hold no engine entry ids,
// only their own user-turn ordinal, so the engine resolves that ordinal to a
// precise tree entry here and derives the plan-file continuity for the branch
// point from the tree itself.

// UserMessageEntryID returns the tree-entry id of the Nth (0-based) user turn on
// the current context path. It resolves the ordinal by reusing flattenEntries —
// the exact function that produces the rows a client renders — so the ordinal a
// client sends (its Nth role=="user" row) maps to the same entry the client is
// looking at, including slash-command pills and DisplayOnly turns, and excluding
// tool_result-only user entries that never render as a user row.
//
// Returns ("", false) when the ordinal is out of range. A user text row is
// always the first row its entry produces, so the row id equals the entry id
// (see flattenEntries' rowID(entry.ID, 0) for the user case).
func UserMessageEntryID(conv *Conversation, userTurnIndex int) (string, bool) {
	if userTurnIndex < 0 {
		return "", false
	}
	rows := flattenEntries(conv)
	count := 0
	for _, r := range rows {
		if r.Role != "user" {
			continue
		}
		if count == userTurnIndex {
			return r.ID, true
		}
		count++
	}
	return "", false
}

// PlanStateAtLeaf returns the plan-file continuity in effect at the current
// leaf: the path and slug of the last plan-file-written marker on the context
// path (leaf → root, root-first order). After a rewind moves the leaf, this is
// the plan the conversation was working under at that point, derived from the
// authoritative tree (EntryPlanMarker) rather than reconstructed by the client.
//
// Returns ("", "") when no plan marker precedes the leaf — the conversation was
// rewound to before any plan existed, so the session should carry no plan file.
func PlanStateAtLeaf(conv *Conversation) (planFilePath, planSlug string) {
	path := getContextPathEntries(conv)
	for _, e := range path {
		if e.Type != EntryPlanMarker {
			continue
		}
		if pd := asPlanMarkerData(e.Data); pd != nil {
			planFilePath = pd.PlanFilePath
			planSlug = pd.PlanSlug
		}
	}
	return planFilePath, planSlug
}
