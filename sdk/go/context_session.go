// context_session.go — the session-scoped context surface: prompting,
// elicitation, history, plan mode, cross-session messaging, schedules, and
// run-once coordination.
//
// Every method here is an RPC. The engine applies no timeout of its own to an
// ext/* call, so the context.Context a caller passes is the only bound — which
// is why it is the first parameter on all of them rather than an option.
package ion

import (
	"context"
	"fmt"
)

// SendPromptOpts configures [Context.SendPrompt].
type SendPromptOpts struct {
	// Model overrides the session model for this one prompt.
	Model string
	// BashAllowlistAdditions grants extra bash patterns for this run only.
	// The engine unions them with the session allowlist and never persists
	// them.
	BashAllowlistAdditions []string
	// Kind labels the injection for observability, surfacing on the
	// engine_prompt_injected event.
	Kind string
}

// SendPrompt injects a prompt into the session, starting a run if none is
// active.
func (c *Context) SendPrompt(ctx context.Context, text string, opts SendPromptOpts) error {
	if text == "" {
		return fmt.Errorf("ion: SendPrompt requires text")
	}
	params := map[string]any{"text": text, "model": opts.Model}
	// Send the allowlist only when non-empty: the engine's field is
	// omitempty, and an empty array is not the same as an absent one.
	if len(opts.BashAllowlistAdditions) > 0 {
		params["bashAllowlistAdditions"] = opts.BashAllowlistAdditions
	}
	if opts.Kind != "" {
		params["kind"] = opts.Kind
	}
	return c.sdk.call(ctx, "ext/send_prompt", params, nil)
}

// Elicit asks the user for structured input and waits for the answer. The
// engine does not time this out, so the caller's context is what bounds the
// wait.
func (c *Context) Elicit(ctx context.Context, opts ElicitOptions) (ElicitResult, error) {
	var out ElicitResult
	err := c.sdk.call(ctx, "ext/elicit", opts, &out)
	return out, err
}

// GetContextUsage returns the active run's context-window readout, or nil when
// no run is active.
func (c *Context) GetContextUsage(ctx context.Context) (*ContextUsage, error) {
	var out *ContextUsage
	if err := c.sdk.call(ctx, "ext/get_context_usage", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SearchHistory searches the active conversation. maxResults of 0 lets the
// engine choose. Returns an empty slice — never nil — when nothing matches or
// no conversation is active.
func (c *Context) SearchHistory(ctx context.Context, query string, maxResults int) ([]HistoryMatch, error) {
	var out []HistoryMatch
	err := c.sdk.call(ctx, "ext/search_history",
		map[string]any{"query": query, "maxResults": maxResults}, &out)
	if err != nil {
		return nil, err
	}
	if out == nil {
		return []HistoryMatch{}, nil
	}
	return out, nil
}

// GetSessionMemory reads the conversation's .memory.md content.
func (c *Context) GetSessionMemory(ctx context.Context) (string, error) {
	var out struct {
		Content string `json:"content"`
	}
	err := c.sdk.call(ctx, "ext/get_session_memory", map[string]any{}, &out)
	return out.Content, err
}

// SetSessionMemory replaces the conversation's .memory.md content.
func (c *Context) SetSessionMemory(ctx context.Context, content string) error {
	return c.sdk.call(ctx, "ext/set_session_memory", map[string]string{"content": content}, nil)
}

// Notify sends a push notification through the engine's relay pipeline. Keep
// the body a doorbell and put the content in a resource — see [NotifyOpts].
func (c *Context) Notify(ctx context.Context, opts NotifyOpts) error {
	return c.sdk.call(ctx, "ext/notify", opts, nil)
}

// Intercept emits an engine_intercept event on a target session's stream.
func (c *Context) Intercept(ctx context.Context, params map[string]any) error {
	return c.sdk.call(ctx, "ext/intercept", params, nil)
}

// SessionsAPI is the cross-session messaging surface, reached via
// [Context.Sessions].
type SessionsAPI struct{ ctx *Context }

// Sessions returns the cross-session messaging surface.
func (c *Context) Sessions() *SessionsAPI { return &SessionsAPI{ctx: c} }

// List returns the engine's live sessions.
func (s *SessionsAPI) List(ctx context.Context) ([]SessionListEntry, error) {
	var out []SessionListEntry
	if err := s.ctx.sdk.call(ctx, "ext/list_sessions", map[string]any{}, &out); err != nil {
		return nil, err
	}
	if out == nil {
		return []SessionListEntry{}, nil
	}
	return out, nil
}

// Send delivers a message to another session of this extension, firing the
// session_message hook there. The receiver can react however it likes —
// abort, inject context, emit a message, or ignore it.
func (s *SessionsAPI) Send(ctx context.Context, targetKey, kind string, payload map[string]any) error {
	return s.ctx.sdk.call(ctx, "ext/send_to_session", map[string]any{
		"targetKey": targetKey,
		"kind":      kind,
		"payload":   payload,
	}, nil)
}

// FireSchedule triggers a registered job immediately, out of band with its
// normal timing. The handler receives ScheduleFireMeta with Backfill set.
func (c *Context) FireSchedule(ctx context.Context, id string) error {
	return c.sdk.call(ctx, "ext/fire_schedule", map[string]string{"id": id}, nil)
}

// GetScheduleStatus returns the state of one job, or of every registered job
// when id is empty.
func (c *Context) GetScheduleStatus(ctx context.Context, id string) ([]ScheduleStatus, error) {
	var out []ScheduleStatus
	if err := c.sdk.call(ctx, "ext/get_schedule_status", map[string]string{"id": id}, &out); err != nil {
		return nil, err
	}
	if out == nil {
		return []ScheduleStatus{}, nil
	}
	return out, nil
}

// SetRunRecovery applies an extension-owned recovery policy to this session.
// Enabled must be set. The setting overrides session and engine defaults for
// later runs; it does not change an active run's journal.
func (c *Context) SetRunRecovery(ctx context.Context, config RunRecoveryConfig) error {
	if config.Enabled == nil {
		return fmt.Errorf("ion: SetRunRecovery requires Enabled")
	}
	return c.sdk.call(ctx, "ext/set_run_recovery", config, nil)
}

// EnterPlanMode puts the session into plan mode.
func (c *Context) EnterPlanMode(ctx context.Context) error {
	return c.sdk.call(ctx, "ext/set_plan_mode",
		map[string]any{"enabled": true, "source": "extension"}, nil)
}

// ExitPlanMode takes the session out of plan mode.
func (c *Context) ExitPlanMode(ctx context.Context) error {
	return c.sdk.call(ctx, "ext/set_plan_mode",
		map[string]any{"enabled": false, "source": "extension"}, nil)
}

// GetPlanMode returns the session's plan-mode state.
func (c *Context) GetPlanMode(ctx context.Context) (PlanModeState, error) {
	var out PlanModeState
	err := c.sdk.call(ctx, "ext/get_plan_mode", map[string]any{}, &out)
	return out, err
}

// RunOnce runs fn at most once per debounce window across every instance of
// this extension.
//
// The engine holds the lock, so this coordinates across processes, not just
// goroutines — which is the point: several sessions loading the same extension
// would otherwise each run the same startup work. A failing fn releases the
// lock so the next instance can retry, and the error propagates.
func (c *Context) RunOnce(ctx context.Context, id string, opts RunOnceOpts, fn func() error) (RunOnceResult, error) {
	debounce := opts.DebounceMs
	if debounce == 0 {
		debounce = 60000
	}

	var check struct {
		Execute bool   `json:"execute"`
		Reason  string `json:"reason"`
	}
	if err := c.sdk.call(ctx, "ext/run_once_check",
		map[string]any{"id": id, "debounceMs": debounce}, &check); err != nil {
		return RunOnceResult{}, err
	}
	if !check.Execute {
		reason := check.Reason
		if reason == "" {
			reason = "debounced"
		}
		c.sdk.logger.Debug("run_once skipped", map[string]any{"id": id, "reason": reason})
		return RunOnceResult{Executed: false, Reason: reason}, nil
	}

	runErr := fn()

	// Always report completion, success or failure: the lock is held until we
	// do, and a failed run that never reports would block every future
	// attempt for the lifetime of the engine.
	if err := c.sdk.call(ctx, "ext/run_once_complete",
		map[string]any{"id": id, "failed": runErr != nil}, nil); err != nil {
		c.sdk.logger.Error("run_once completion not recorded; the lock may stay held",
			map[string]any{"id": id, "error": err.Error()})
	}

	if runErr != nil {
		return RunOnceResult{Executed: true}, runErr
	}
	return RunOnceResult{Executed: true}, nil
}
