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

// IsUserTurnEntryOnCurrentPath reports whether entryID names a genuine
// client-facing user-turn row on the conversation's CURRENT context path (leaf
// → root). This is the validation gate for exact-entry rewind: a client that
// retained an EntryID from a prior engine_steer_injected confirmation, or from
// loaded conversation history, may be naming an entry that (a) never existed,
// (b) belongs to a different branch than the one currently active, or (c)
// exists but is not a user row at all (an assistant turn, a tool result, a
// marker). Any of those must be rejected before BranchBefore runs — that
// primitive trusts its entryID argument completely and will happily branch
// before a non-user or now-orphaned entry, silently corrupting the tree in a
// way ordinal resolution structurally cannot (an out-of-range ordinal just
// fails UserMessageEntryID's count comparison; an exact id has no such
// automatic bound).
//
// Reuses flattenEntries so the definition of "a user row" is identical to the
// one UserMessageEntryID and the client's own rendered list use — the same
// rowID(entry.ID, 0) identity a genuine user turn's first (and only) row
// carries.
func IsUserTurnEntryOnCurrentPath(conv *Conversation, entryID string) bool {
	if entryID == "" {
		return false
	}
	rows := flattenEntries(conv)
	for _, r := range rows {
		if r.ID == entryID {
			return r.Role == "user"
		}
	}
	return false
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
