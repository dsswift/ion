package conversation

import "github.com/dsswift/ion/engine/internal/utils"

// plan_retention.go — resolves the plan a `/clear --keep-plan` should retain.
//
// The rule is precise and tree-native: keep the LATEST plan on the current
// context path, but only when no implementation turn followed it. A plan whose
// implementation already began is "spent" — clearing to keep it would re-seed
// the context with work the conversation had already moved past. This mirrors
// the desktop's findPlanImplementation (clear-divider.ts) but reads the
// authoritative engine tree (EntryPlanMarker + MessageData.ImplementationPhase)
// rather than reconstructed client rows, so the two never drift.

// LatestUnimplementedPlan walks the current context path (root → leaf) and
// returns the last plan-file-written marker that has NO implementation-phase
// user turn after it. Returns found=false when there is no plan marker on the
// path, or when the latest plan's implementation had already begun.
//
// Walk semantics: each EntryPlanMarker resets the candidate to that plan and
// clears the "implemented" flag (a newer plan supersedes an older one and is
// judged on its own implementation state). Each user turn carrying
// ImplementationPhase marks the current candidate as implemented. The verdict
// is read once at the end: a candidate that survived unimplemented is kept.
//
// It is safe to call AFTER the /clear wipe: the wipe nils conv.Messages and
// appends EntryCleared, but the plan markers and implementation-phase user
// turns remain on the context path (getContextPathEntries returns the full
// leaf → root path, exactly as PlanStateAtLeaf relies on).
func LatestUnimplementedPlan(conv *Conversation) (planFilePath, planSlug string, found bool) {
	var candPath, candSlug string
	var haveCandidate, implemented bool

	// Counters exist so a "not found" verdict is diagnosable from the log
	// alone. The three ways this returns false are indistinguishable in the
	// return value — no markers on the path, markers present but every one
	// carried an empty path, or a marker whose implementation had begun — and
	// they call for three different fixes. Reading the tree by hand to tell
	// them apart is exactly the blind spot this counts away.
	pathLen := 0
	markerCount := 0
	implPhaseTurns := 0

	entries := getContextPathEntries(conv)
	for _, e := range entries {
		pathLen++
		switch e.Type {
		case EntryPlanMarker:
			markerCount++
			if pd := asPlanMarkerData(e.Data); pd != nil && pd.PlanFilePath != "" {
				candPath = pd.PlanFilePath
				candSlug = pd.PlanSlug
				haveCandidate = true
				implemented = false
			}
		case EntryMessage:
			if md := asMessageData(e.Data); md != nil && md.Role == "user" && md.ImplementationPhase {
				implPhaseTurns++
				implemented = true
			}
		}
	}

	fields := map[string]any{
		"conversation_id":  conv.ID,
		"path_entries":     pathLen,
		"plan_markers":     markerCount,
		"impl_phase_turns": implPhaseTurns,
		"have_candidate":   haveCandidate,
		"implemented":      implemented,
		"plan_file_path":   candPath,
		"plan_slug":        candSlug,
	}
	if haveCandidate && !implemented {
		fields["outcome"] = "keep"
		utils.LogWithFields(utils.LevelInfo, "conversation.plan_retention", "latestunimplementedplan: resolved a plan to keep", fields)
		return candPath, candSlug, true
	}
	switch {
	case markerCount == 0:
		fields["outcome"] = "no_marker_on_path"
	case !haveCandidate:
		fields["outcome"] = "markers_present_but_none_carried_a_path"
	default:
		fields["outcome"] = "latest_plan_already_implemented"
	}
	utils.LogWithFields(utils.LevelInfo, "conversation.plan_retention", "latestunimplementedplan: nothing to keep", fields)
	return "", "", false
}
