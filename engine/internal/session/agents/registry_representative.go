package agents

import "github.com/dsswift/ion/engine/internal/types"

// liveness ranks an agent status by whether the work is still in flight.
//
// Deliberately coarse: it separates live from terminal and nothing else.
// Ordering WITHIN the terminal group is recency's job, not the status
// vocabulary's — an error is not "more representative" than a done, it is only
// a different outcome. The rule this replaced ranked every status against every
// other (running 4 > suspended 3 > error 2 > done 1 > cancelled 0), which is
// how an old failure came to outrank a newer success.
func liveness(status string) int {
	switch status {
	case "running":
		return 2
	case "suspended":
		// Still alive: the dispatch is parked awaiting children, a background
		// command, or a poll, not finished.
		return 2
	default:
		return 1
	}
}

// startedAtOf reads a dispatch's start time from agent metadata.
//
// Stamped as "startTime" (unix seconds) at dispatch registration, so it is
// present on every engine dispatch row. Metadata crosses the wire as JSON,
// where the number arrives as float64, while an in-process value is still an
// int — both must read as the same instant or recency comparison flips
// depending on whether the snapshot was rehydrated.
//
// Zero when absent, which sorts oldest. An extension roster row has no start
// time and never competes with a real dispatch for a slot.
func startedAtOf(meta map[string]interface{}) int64 {
	if meta == nil {
		return 0
	}
	switch v := meta["startTime"].(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case float64:
		return int64(v)
	default:
		return 0
	}
}

// representativeBeats reports whether candidate should replace current as the
// row a consumer sees for a group.
//
// Live work first, then most recently started. Equal on both is a tie that
// resolves to the later slice position (the caller iterates forward and only
// replaces on a strict win, so insertion order breaks it) — the
// most-recently-added entry, matching the previous behavior for genuine ties.
func representativeBeats(candidate, current types.AgentStateUpdate) bool {
	candLive, curLive := liveness(candidate.Status), liveness(current.Status)
	if candLive != curLive {
		return candLive > curLive
	}
	candStart, curStart := startedAtOf(candidate.Metadata), startedAtOf(current.Metadata)
	if candStart != curStart {
		return candStart > curStart
	}
	return true
}
