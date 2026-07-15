// Schedule status types for the extension SDK. Split from sdk_types.go
// to keep that file under the 800-line cap.

package extension

// ScheduleStatusEntry describes the current status of a registered schedule
// job. Returned by ctx.GetScheduleStatus / the ext/get_schedule_status RPC.
type ScheduleStatusEntry struct {
	// ID is the job's stable identifier.
	ID string `json:"id"`
	// Kind is "daily", "weekly", "interval", or "once".
	Kind string `json:"kind"`
	// LastRunUtc is the RFC3339 UTC timestamp of the last successful fire.
	// Empty when the job has never run.
	LastRunUtc string `json:"lastRunUtc,omitempty"`
	// RanWithinScope is true when the job ran inside its current
	// interval-scope window (today for daily, this week for weekly).
	RanWithinScope bool `json:"ranWithinScope"`
	// NextRunUtc is the RFC3339 UTC timestamp of the next scheduled fire.
	// Empty when the next-run has not been computed yet.
	NextRunUtc string `json:"nextRunUtc,omitempty"`
}
