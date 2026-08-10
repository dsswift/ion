// schedule.go — scheduled job registration.
//
// The engine owns the scheduler: the timing, the persistence across restarts,
// the missed-slot detection. An extension declares when a job should fire and
// what it should do; everything about *when* is the engine's mechanism and
// everything about *what* is the extension's opinion.
//
// Four kinds: daily and weekly fire at a wall-clock time in a timezone,
// interval fires every N milliseconds, and once fires a single time after a
// delay and then deregisters itself on both sides.
package ion

import (
	"context"
	"fmt"
)

// ScheduleKind is a job's firing pattern.
type ScheduleKind string

const (
	// ScheduleKindDaily fires once per day at a wall-clock time.
	ScheduleKindDaily ScheduleKind = "daily"
	// ScheduleKindWeekly fires once per week on a given day.
	ScheduleKindWeekly ScheduleKind = "weekly"
	// ScheduleKindInterval fires every IntervalMs.
	ScheduleKindInterval ScheduleKind = "interval"
	// ScheduleKindOnce fires a single time after DelayMs, then
	// auto-deregisters.
	ScheduleKindOnce ScheduleKind = "once"
)

// ScheduleJob is a job declaration as it crosses the wire.
type ScheduleJob struct {
	// ID is the job's stable identifier, unique within this extension.
	ID string `json:"id"`
	// Kind is the firing pattern.
	Kind ScheduleKind `json:"kind"`
	// Time is "HH:MM" 24-hour, for daily and weekly.
	Time string `json:"time,omitempty"`
	// DayOfWeek is "monday" through "sunday", for weekly.
	DayOfWeek string `json:"dayOfWeek,omitempty"`
	// IntervalMs is the period for interval jobs. Minimum 1000.
	IntervalMs int64 `json:"intervalMs,omitempty"`
	// DelayMs is the delay before a once job fires. Minimum 1000.
	DelayMs int64 `json:"delayMs,omitempty"`
	// TZ is an IANA timezone. Empty inherits the engine default.
	TZ string `json:"tz,omitempty"`
	// TimeoutMs caps how long a single firing may run.
	TimeoutMs int64 `json:"timeoutMs,omitempty"`
	// EnabledRefName is the symbolic name of the enabled() predicate. Set by
	// the SDK; do not populate it directly.
	EnabledRefName string `json:"enabledRefName,omitempty"`
	// Concurrency is "single" (default) or "all".
	Concurrency string `json:"concurrency,omitempty"`
}

// ScheduleFireMeta describes one firing, letting a handler tell a live tick
// from a backfill.
type ScheduleFireMeta struct {
	// FiredAt is the RFC3339 UTC timestamp of the firing.
	FiredAt string `json:"firedAt"`
	// Backfill reports a catch-up fire for a slot missed while the engine was
	// down, or one triggered by [Context.FireSchedule].
	Backfill bool `json:"backfill"`
	// MissedSlotUtc is the slot being backfilled, when Backfill is set.
	MissedSlotUtc string `json:"missedSlotUtc,omitempty"`
}

// ScheduleControl is handed to a handler so it can inspect its own job id or
// stop future firings from inside the firing.
type ScheduleControl struct {
	// JobID is the id this handler was registered under.
	JobID string

	unregister func(context.Context) error
}

// Unregister stops all future firings of this job. For a once job the engine
// already deregisters after the handler returns, so calling this is harmless
// and redundant; for daily, weekly, and interval it is how a handler decides
// mid-run that the job is finished.
func (c ScheduleControl) Unregister(ctx context.Context) error {
	if c.unregister == nil {
		return fmt.Errorf("ion: schedule control for %q has no unregister binding", c.JobID)
	}
	return c.unregister(ctx)
}

// ScheduleHandler runs one firing of a job.
type ScheduleHandler func(c context.Context, ctx *Context, control ScheduleControl, meta ScheduleFireMeta) error

// ScheduleHandle refers to a registered job.
type ScheduleHandle struct {
	// ID is the job id.
	ID  string
	reg *asyncRegistry
}

// Unregister removes the job.
func (h ScheduleHandle) Unregister(c context.Context) error {
	return h.reg.unregisterSchedule(c, h.ID)
}

// ScheduleOpts configures a registration. Which fields apply depends on the
// kind; the per-kind methods on [ScheduleAPI] take only the relevant ones.
type ScheduleOpts struct {
	// ID is the job's stable identifier. Required.
	ID string
	// Time is "HH:MM" 24-hour, for daily and weekly.
	Time string
	// DayOfWeek is "monday" through "sunday", for weekly.
	DayOfWeek string
	// IntervalMs is the period for interval jobs.
	IntervalMs int64
	// DelayMs is the delay for once jobs.
	DelayMs int64
	// TZ is an IANA timezone. Empty inherits the engine default.
	TZ string
	// TimeoutMs caps a single firing.
	TimeoutMs int64
	// Concurrency is "single" (default) or "all".
	Concurrency string
	// Enabled is consulted before each firing. Returning false skips it
	// without deregistering the job, so a job can be gated on config the
	// extension reads at fire time. Nil means always enabled.
	Enabled func() (bool, error)
}

// ScheduleAPI is the schedule registration surface, reached via
// [SDK.Schedule].
type ScheduleAPI struct{ reg *asyncRegistry }

// Daily registers a job that fires once per day at opts.Time.
func (s *ScheduleAPI) Daily(c context.Context, opts ScheduleOpts, handler ScheduleHandler) (ScheduleHandle, error) {
	return s.register(c, ScheduleJob{
		ID:          opts.ID,
		Kind:        ScheduleKindDaily,
		Time:        opts.Time,
		TZ:          opts.TZ,
		TimeoutMs:   opts.TimeoutMs,
		Concurrency: opts.Concurrency,
	}, opts.Enabled, handler, false)
}

// Weekly registers a job that fires once per week on opts.DayOfWeek at
// opts.Time.
func (s *ScheduleAPI) Weekly(c context.Context, opts ScheduleOpts, handler ScheduleHandler) (ScheduleHandle, error) {
	return s.register(c, ScheduleJob{
		ID:          opts.ID,
		Kind:        ScheduleKindWeekly,
		Time:        opts.Time,
		DayOfWeek:   opts.DayOfWeek,
		TZ:          opts.TZ,
		TimeoutMs:   opts.TimeoutMs,
		Concurrency: opts.Concurrency,
	}, opts.Enabled, handler, false)
}

// Interval registers a job that fires every opts.IntervalMs.
func (s *ScheduleAPI) Interval(c context.Context, opts ScheduleOpts, handler ScheduleHandler) (ScheduleHandle, error) {
	return s.register(c, ScheduleJob{
		ID:          opts.ID,
		Kind:        ScheduleKindInterval,
		IntervalMs:  opts.IntervalMs,
		TimeoutMs:   opts.TimeoutMs,
		Concurrency: opts.Concurrency,
	}, opts.Enabled, handler, false)
}

// Once registers a job that fires a single time after opts.DelayMs and then
// deregisters itself on both the engine and the SDK side.
func (s *ScheduleAPI) Once(c context.Context, opts ScheduleOpts, handler ScheduleHandler) (ScheduleHandle, error) {
	return s.register(c, ScheduleJob{
		ID:          opts.ID,
		Kind:        ScheduleKindOnce,
		DelayMs:     opts.DelayMs,
		TZ:          opts.TZ,
		TimeoutMs:   opts.TimeoutMs,
		Concurrency: opts.Concurrency,
	}, opts.Enabled, handler, true)
}

// Cancel removes a job by id. The id-addressable complement to
// [ScheduleHandle.Unregister], for callers that did not keep the handle.
func (s *ScheduleAPI) Cancel(c context.Context, id string) error {
	return s.reg.unregisterSchedule(c, id)
}

func (s *ScheduleAPI) register(
	c context.Context,
	job ScheduleJob,
	enabled func() (bool, error),
	handler ScheduleHandler,
	isOnce bool,
) (ScheduleHandle, error) {
	if job.ID == "" {
		return ScheduleHandle{}, fmt.Errorf("ion: schedule registration requires an id")
	}
	if handler == nil {
		return ScheduleHandle{}, fmt.Errorf("ion: schedule %q has no handler", job.ID)
	}
	r := s.reg

	if enabled != nil {
		job.EnabledRefName = predicateRefName(job.ID)
	}

	r.mu.Lock()
	r.scheduleHandlers[job.ID] = handler
	if enabled != nil {
		r.predicateRefs[job.EnabledRefName] = enabled
	}
	if isOnce {
		r.onceJobs[job.ID] = true
	}
	r.mu.Unlock()

	err := r.register(c, "ext/register_schedule", job, func() {
		r.pendingSchedules = append(r.pendingSchedules, job)
	})
	if err != nil {
		// Vetoed or invalid. Drop the local handler so a stray fire cannot
		// reach a job the engine never accepted.
		r.mu.Lock()
		delete(r.scheduleHandlers, job.ID)
		delete(r.predicateRefs, job.EnabledRefName)
		delete(r.onceJobs, job.ID)
		r.mu.Unlock()
		r.sdk.logger.Error("schedule registration refused", map[string]any{
			"job": job.ID, "kind": string(job.Kind), "error": err.Error(),
		})
		return ScheduleHandle{}, err
	}

	r.sdk.logger.Info("schedule registered", map[string]any{
		"job":  job.ID,
		"kind": string(job.Kind),
	})
	return ScheduleHandle{ID: job.ID, reg: r}, nil
}

// unregisterSchedule removes a job locally and, post-init, on the engine too.
func (r *asyncRegistry) unregisterSchedule(c context.Context, id string) error {
	r.mu.Lock()
	delete(r.scheduleHandlers, id)
	delete(r.predicateRefs, predicateRefName(id))
	delete(r.onceJobs, id)
	if !r.sdk.initialized() {
		filtered := r.pendingSchedules[:0]
		for _, job := range r.pendingSchedules {
			if job.ID != id {
				filtered = append(filtered, job)
			}
		}
		r.pendingSchedules = filtered
		r.mu.Unlock()
		return nil
	}
	r.mu.Unlock()

	if err := r.sdk.call(c, "ext/deregister_schedule", map[string]string{"id": id}, nil); err != nil {
		r.sdk.logger.Error("schedule deregistration failed", map[string]any{"job": id, "error": err.Error()})
		return err
	}
	r.sdk.logger.Info("schedule deregistered", map[string]any{"job": id})
	return nil
}

// ScheduleStatus is one job's runtime state, from
// [Context.GetScheduleStatus].
type ScheduleStatus struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// LastRunUtc is the RFC3339 UTC time of the last successful firing.
	// Empty when the job has never run.
	LastRunUtc string `json:"lastRunUtc,omitempty"`
	// NextRunUtc is the RFC3339 UTC time of the next scheduled firing.
	NextRunUtc string `json:"nextRunUtc,omitempty"`
	// Enabled reflects the job's predicate at the time of the query.
	Enabled bool `json:"enabled"`
}
