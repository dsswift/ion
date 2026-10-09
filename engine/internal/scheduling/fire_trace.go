package scheduling

import "github.com/dsswift/ion/engine/internal/extension"

// fireTraceContext gives one schedule fire its own trace: the resolved
// session context, copied, with a fresh trace-id and the fire as root span.
// The handler's envelope, the hooks the engine records around its calls, and
// the prompts it sends all join that trace (extension.Context.WithTraceRoot).
// The resolver's context is never mutated: it may be shared across fires.
func fireTraceContext(ctx *extension.Context, job extension.ScheduleJob) *extension.Context {
	return ctx.WithTraceRoot("schedule", job.JobID)
}
