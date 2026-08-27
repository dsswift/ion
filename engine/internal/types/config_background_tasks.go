package types

// BackgroundTasksConfig governs what the engine does when a background bash
// command started with notify_on_complete finishes.
//
// The mechanism — tracking outstanding commands, holding the session open at a
// turn boundary, emitting the typed completion event, firing the extension
// hook — is engine-owned and not configurable. What IS an opinion, and
// therefore lives here, is the delivery policy: whether a completion should
// start a run on an otherwise-idle session. A consumer that never wants the
// engine to begin work unattended sets Delivery to "event_only" or "queue" and
// still receives the typed event and the hook.
type BackgroundTasksConfig struct {
	// Delivery selects how a completion reaches the session.
	//
	//	"wake"       (default) — an idle or parked session is woken: the
	//	                         completion is injected as a prompt and a run
	//	                         starts. This is what makes "start a long
	//	                         command, go idle, resume when it finishes"
	//	                         work unattended.
	//	"queue"      — the completion is held and delivered with the next run
	//	               the session starts for any other reason. Nothing runs
	//	               unattended.
	//	"event_only" — the typed event and the hook fire; nothing is injected
	//	               and no run starts. For consumers driving their own
	//	               orchestration off the event stream.
	//
	// A completion arriving while a run is ALREADY active is always delivered
	// mid-turn via the steer path regardless of this setting: there is no
	// unattended-run concern when the session is already working.
	//
	// Empty means "wake".
	Delivery string `json:"delivery,omitempty"`

	// MaxOutstandingPerSession bounds how many notifying background commands
	// one session may have outstanding at once. Further notify_on_complete
	// requests still start their command, but are not tracked as outstanding
	// (they behave like a plain run_in_background task), so a runaway loop
	// cannot grow the set without limit. Zero or negative means the compiled
	// default.
	MaxOutstandingPerSession int `json:"maxOutstandingPerSession,omitempty"`

	// ParkTimeoutMs bounds how long a session stays parked waiting for its
	// outstanding commands. A command that never exits (a wedged build, a dev
	// server that runs forever) would otherwise park the session until
	// teardown. On timeout the session is woken with a payload naming the
	// tasks it is still waiting on; those tasks REMAIN outstanding, so a later
	// exit still notifies normally. Zero or negative means the compiled
	// default.
	ParkTimeoutMs int `json:"parkTimeoutMs,omitempty"`

	// MaxRetainedFinishedTasksPerSession limits terminal Bash task records and
	// their output files. The newest records survive so a delivered completion
	// can still name an output path for a later explicit read.
	MaxRetainedFinishedTasksPerSession int `json:"maxRetainedFinishedTasksPerSession,omitempty"`
}

// Background-task delivery modes. Values for BackgroundTasksConfig.Delivery.
const (
	// BackgroundDeliveryWake wakes an idle or parked session by injecting the
	// completion as a prompt and starting a run.
	BackgroundDeliveryWake = "wake"
	// BackgroundDeliveryQueue holds the completion until the session next
	// starts a run for another reason.
	BackgroundDeliveryQueue = "queue"
	// BackgroundDeliveryEventOnly emits the typed event and fires the hook
	// without injecting anything or starting a run.
	BackgroundDeliveryEventOnly = "event_only"
)

// Compiled defaults for BackgroundTasksConfig. ParkTimeoutMs is 30 minutes:
// long enough that an ordinary long build or test suite finishes well inside
// it, short enough that a wedged command does not strand a session for a whole
// working day.
const (
	defaultMaxOutstandingPerSession           = 32
	defaultParkTimeoutMs                      = 30 * 60 * 1000
	defaultMaxRetainedFinishedTasksPerSession = 32
)

// BackgroundTasksDefaults returns the compiled default configuration, used
// when engine.json omits the backgroundTasks block entirely.
func BackgroundTasksDefaults() BackgroundTasksConfig {
	return BackgroundTasksConfig{
		Delivery:                           BackgroundDeliveryWake,
		MaxOutstandingPerSession:           defaultMaxOutstandingPerSession,
		ParkTimeoutMs:                      defaultParkTimeoutMs,
		MaxRetainedFinishedTasksPerSession: defaultMaxRetainedFinishedTasksPerSession,
	}
}

// Resolved returns the configuration with every unset field replaced by its
// compiled default, so callers never branch on zero values. Safe on a nil
// receiver: a nil config resolves to the full defaults.
func (c *BackgroundTasksConfig) Resolved() BackgroundTasksConfig {
	out := BackgroundTasksDefaults()
	if c == nil {
		return out
	}
	switch c.Delivery {
	case BackgroundDeliveryWake, BackgroundDeliveryQueue, BackgroundDeliveryEventOnly:
		out.Delivery = c.Delivery
	}
	if c.MaxOutstandingPerSession > 0 {
		out.MaxOutstandingPerSession = c.MaxOutstandingPerSession
	}
	if c.ParkTimeoutMs > 0 {
		out.ParkTimeoutMs = c.ParkTimeoutMs
	}
	if c.MaxRetainedFinishedTasksPerSession > 0 {
		out.MaxRetainedFinishedTasksPerSession = c.MaxRetainedFinishedTasksPerSession
	}
	return out
}
