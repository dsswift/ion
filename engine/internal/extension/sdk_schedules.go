// SDK declarations for scheduled jobs — surface registered by extensions
// at init time (bulk) or dynamically via the ext/register_schedule RPC.
//
// The declaration shape is the contract extensions emit to the engine.
// Three discriminated kinds (daily / weekly / interval) keep the API
// minimal while covering the cases harness extensions actually need.
// Cron expressions were considered and explicitly rejected in D-010
// alternative 3 — the three shapes here are the entire MVP.
//
// EnabledRefName carries the same callback-resolution mechanism as
// webhook TokenRefName: the SDK runtime stores the user's `() => bool`
// predicate under that name and the engine calls back to resolve it at
// fire time. This keeps "should this job fire right now?" decisions in
// the extension where they belong.

package extension

import "fmt"

// ScheduleKind discriminates the three supported job shapes. Adding a
// new kind requires extending the scheduler's tick loop; the registry
// is kind-agnostic.
type ScheduleKind string

const (
	// ScheduleDaily fires once per day at Time (HH:MM) in the
	// declaration's Tz (or engine default tz).
	ScheduleDaily ScheduleKind = "daily"
	// ScheduleWeekly fires once per week on DayOfWeek at Time (HH:MM).
	// DayOfWeek is the lowercased English name ("monday", "tuesday", …).
	ScheduleWeekly ScheduleKind = "weekly"
	// ScheduleInterval fires every IntervalMs milliseconds, starting
	// IntervalMs after the registration time (no immediate fire).
	ScheduleInterval ScheduleKind = "interval"
	// ScheduleOnce fires exactly once after DelayMs milliseconds, then
	// self-deregisters. The scheduler removes the job from the host
	// registry after the handler returns (success or error), so no
	// second fire can occur. A once job whose enabled predicate returns
	// false is skipped for that tick but remains armed and retries on
	// the next tick — the predicate skip does NOT consume the shot.
	ScheduleOnce ScheduleKind = "once"
)

// ScheduleJob is the full registration declaration for one job.
type ScheduleJob struct {
	// JobID is the stable identifier the extension uses to refer to
	// this job. Required — empty IDs are rejected by the registry.
	JobID string `json:"id"`
	// Kind is the trigger shape. Required.
	Kind ScheduleKind `json:"kind"`
	// Time is the wall-clock HH:MM (24-hour) for daily / weekly jobs.
	// Ignored for interval. Required when Kind is daily or weekly.
	Time string `json:"time,omitempty"`
	// DayOfWeek is the lowercased English weekday for weekly jobs.
	// Required for weekly; ignored for daily / interval.
	DayOfWeek string `json:"dayOfWeek,omitempty"`
	// IntervalMs is the millisecond interval for interval jobs.
	// Required for interval; ignored for daily / weekly / once. Must be
	// at least 1000 ms (one second) — the scheduler ticks at 1s
	// granularity and any finer interval would alias unpredictably.
	IntervalMs int64 `json:"intervalMs,omitempty"`
	// DelayMs is the millisecond delay-to-first-fire for once jobs.
	// Required for once; ignored for all other kinds. Must be at least
	// 1000 ms (scheduler tick floor). After the handler fires, the
	// engine removes the job from the registry; no second fire occurs.
	DelayMs int64 `json:"delayMs,omitempty"`
	// Tz is the IANA timezone for daily / weekly resolution. Empty
	// inherits the engine config default tz (or the system local
	// timezone if engine config is unset).
	Tz string `json:"tz,omitempty"`
	// TimeoutMs caps the handler invocation. Zero inherits a per-kind
	// default (interval: IntervalMs, daily/weekly: 60s).
	TimeoutMs int64 `json:"timeoutMs,omitempty"`
	// EnabledRefName, when set, names a `() => bool` callback the
	// extension registered with the SDK. The engine calls back at fire
	// time; false skips the fire and emits engine_schedule_skipped with
	// reason="disabled". Empty means "always enabled".
	EnabledRefName string `json:"enabledRefName,omitempty"`
	// Concurrency controls how many extension instances handle this
	// trigger when multiple sessions load the same extension.
	// "single" (default when empty): one instance fires per tick.
	// "all": every instance fires independently.
	Concurrency string `json:"concurrency,omitempty"`
}

// ID satisfies the asyncreg.Declaration interface. Schedule jobs use
// their JobID as the stable identifier within the registry.
func (j ScheduleJob) ID() string { return j.JobID }

// Validate returns a non-nil error when the job declaration is
// internally inconsistent. Callers use this to reject malformed
// registrations at the RPC boundary so the operator sees a clear
// message rather than a silent never-fires.
func (j ScheduleJob) Validate() error {
	if j.JobID == "" {
		return fmt.Errorf("schedule job id is required")
	}
	switch j.Kind {
	case ScheduleDaily:
		if j.Time == "" {
			return fmt.Errorf("schedule kind=daily requires time HH:MM")
		}
		if err := validateHHMM(j.Time); err != nil {
			return err
		}
	case ScheduleWeekly:
		if j.Time == "" {
			return fmt.Errorf("schedule kind=weekly requires time HH:MM")
		}
		if err := validateHHMM(j.Time); err != nil {
			return err
		}
		if j.DayOfWeek == "" {
			return fmt.Errorf("schedule kind=weekly requires dayOfWeek")
		}
		if !validWeekday(j.DayOfWeek) {
			return fmt.Errorf("schedule weekly: unknown dayOfWeek %q (use monday..sunday lowercased)", j.DayOfWeek)
		}
	case ScheduleInterval:
		if j.IntervalMs < 1000 {
			return fmt.Errorf("schedule kind=interval requires intervalMs >= 1000 (got %d)", j.IntervalMs)
		}
	case ScheduleOnce:
		if j.DelayMs < 1000 {
			return fmt.Errorf("schedule kind=once requires delayMs >= 1000 (got %d)", j.DelayMs)
		}
	default:
		return fmt.Errorf("unknown schedule kind %q", j.Kind)
	}
	if j.TimeoutMs < 0 {
		return fmt.Errorf("schedule timeoutMs must be >= 0 (got %d)", j.TimeoutMs)
	}
	switch j.Concurrency {
	case "", "single", "all":
		// valid
	default:
		return fmt.Errorf("unknown schedule concurrency %q (use \"single\" or \"all\")", j.Concurrency)
	}
	return nil
}

// validateHHMM checks the standard 24-hour HH:MM format. Accepts
// "00:00" through "23:59" inclusive. Returns nil on success.
func validateHHMM(s string) error {
	if len(s) != 5 || s[2] != ':' {
		return fmt.Errorf("schedule time: expected HH:MM, got %q", s)
	}
	h, err1 := atoiPositive(s[0:2])
	m, err2 := atoiPositive(s[3:5])
	if err1 != nil || err2 != nil {
		return fmt.Errorf("schedule time: HH:MM digits required, got %q", s)
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return fmt.Errorf("schedule time: HH must be 00-23 and MM 00-59, got %q", s)
	}
	return nil
}

// atoiPositive parses a non-negative integer from a string. We
// open-code this so the schedule validator has no import cost (and so
// hand-rolling avoids the broader strconv.Atoi surface that accepts
// leading +/-).
func atoiPositive(s string) (int, error) {
	if len(s) == 0 {
		return 0, fmt.Errorf("empty")
	}
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, fmt.Errorf("non-digit")
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}

// validWeekday returns true if s is a recognized lowercased English
// weekday name. Used by Validate.
func validWeekday(s string) bool {
	switch s {
	case "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday":
		return true
	}
	return false
}
