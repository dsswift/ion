// Async-trigger lifecycle hooks: webhook_registered, webhook_deregistered,
// schedule_registered, schedule_deregistered.
//
// The *_registered variants are veto-capable. Handlers express their
// decision through an AsyncRegistrationVeto result (or an equivalent
// JSON-RPC map {block: true, reason: "..."}). The last handler that
// expresses an opinion wins, matching the established veto pattern for
// FireBeforePlanModeEnter (sdk_hooks_lifecycle.go:286-317).
//
// The *_deregistered variants are observation-only: handler return
// values are ignored. Deregistration cannot be blocked because a
// veto there would let one extension permanently trap another
// extension's resources.

package extension

import "fmt"

// AsyncRegistrationInfo is the payload carried to the four async
// lifecycle hooks. It describes which kind of trigger is being
// registered or deregistered, the declaration's stable id, the origin
// (init vs runtime), and a serialisable view of the declaration so
// observability tooling can render it.
//
// Decl is the typed declaration value (WebhookRoute or ScheduleJob).
// Hook handlers can introspect it directly via a Go type switch, or
// inspect the wire-format `decl` field after JSON marshaling.
type AsyncRegistrationInfo struct {
	// Kind is "webhook" or "schedule". String-typed on the wire so
	// JSON-RPC handlers can switch on it without referencing an
	// internal Go enum.
	Kind string `json:"kind"`
	// ID is the declaration's stable identifier within its kind
	// (webhook path, schedule job id).
	ID string `json:"id"`
	// Origin is "init" or "runtime". Lets hook handlers distinguish
	// the bulk init handshake from dynamic add/remove RPCs and apply
	// different policies if they want to.
	Origin string `json:"origin"`
	// Decl is the typed declaration. Set on the Go side; serializes as
	// the JSON field "decl". The marshaling of WebhookRoute redacts
	// nothing (it carries only auth shape and a token-ref name, never
	// secrets). The marshaling of ScheduleJob is similarly safe.
	Decl interface{} `json:"decl,omitempty"`
}

// AsyncRegistrationVeto is the optional return value from a
// *_registered hook handler. A handler that wants to block a
// registration returns `AsyncRegistrationVeto{Block: true, Reason:
// "policy: …"}` (or the equivalent map literal in JSON-RPC). Reason
// is surfaced verbatim to the caller via the RPC error and to the
// observability event.
//
// Returning a zero-value veto, nil, or any other value means "no
// opinion": the registration proceeds (or the next handler in the
// chain may still veto).
type AsyncRegistrationVeto struct {
	Block  bool   `json:"block"`
	Reason string `json:"reason,omitempty"`
}

// FireWebhookRegistered fires the webhook_registered hook and resolves
// the combined veto decision. Returns nil when no handler blocked, or
// a non-nil error carrying the last block reason. Callers should
// surface the error verbatim to the caller of the registration RPC
// (host_rpc.go ext/register_webhook) so the extension sees the policy
// reason rather than a generic "registration failed".
//
// Pattern mirrors FireBeforePlanModeEnter: iterate every handler
// result, last explicit Block wins. Map results from JSON-RPC
// extensions are decoded the same way.
func (s *SDK) FireWebhookRegistered(ctx *Context, info AsyncRegistrationInfo) error {
	return s.fireAsyncRegistrationVeto(HookWebhookRegistered, ctx, info)
}

// FireWebhookDeregistered fires the webhook_deregistered hook.
// Observation-only — handler return values and errors are logged but
// never surfaced to the caller, and they cannot block the
// deregistration that has already occurred at the registry level.
func (s *SDK) FireWebhookDeregistered(ctx *Context, info AsyncRegistrationInfo) {
	s.fire(HookWebhookDeregistered, ctx, info)
}

// FireScheduleRegistered fires the schedule_registered hook and
// resolves the combined veto decision. Symmetric with
// FireWebhookRegistered.
func (s *SDK) FireScheduleRegistered(ctx *Context, info AsyncRegistrationInfo) error {
	return s.fireAsyncRegistrationVeto(HookScheduleRegistered, ctx, info)
}

// FireScheduleDeregistered fires the schedule_deregistered hook.
// Symmetric with FireWebhookDeregistered.
func (s *SDK) FireScheduleDeregistered(ctx *Context, info AsyncRegistrationInfo) {
	s.fire(HookScheduleDeregistered, ctx, info)
}

// ScheduleMissedInfo is the payload for the schedule_missed hook. Fired when
// the scheduler detects a daily/weekly slot was missed while the engine was
// down. Observation-only — no veto. The extension decides whether to backfill
// the missed work via ctx.fireSchedule.
type ScheduleMissedInfo struct {
	// ID is the schedule job's stable identifier.
	ID string `json:"id"`
	// Kind is "daily" or "weekly".
	Kind string `json:"kind"`
	// MissedSlotUtc is the RFC3339 UTC timestamp of the slot that was missed.
	MissedSlotUtc string `json:"missedSlotUtc"`
	// HadMarker is true when a last-run marker existed on disk at detection
	// time. False means the job was known (registered before) but had never
	// run successfully.
	HadMarker bool `json:"hadMarker"`
	// RanWithinScope is true when the job ran at least once inside the
	// current interval-scope window (today for daily, this week for weekly).
	RanWithinScope bool `json:"ranWithinScope"`
}

// FireScheduleMissed fires the schedule_missed hook. Observation-only — no
// veto; handler return values are ignored.
func (s *SDK) FireScheduleMissed(ctx *Context, info ScheduleMissedInfo) {
	s.fire(HookScheduleMissed, ctx, info)
}

// fireAsyncRegistrationVeto is the shared veto-resolution helper for
// both *_registered hooks. Last explicit Block wins, matching
// FireBeforePlanModeEnter. JSON-RPC subprocess extensions return
// map[string]interface{} payloads; we decode the same two fields
// (block, reason) out of them so subprocess and in-process extensions
// behave identically.
func (s *SDK) fireAsyncRegistrationVeto(event string, ctx *Context, info AsyncRegistrationInfo) error {
	results := s.fire(event, ctx, info)
	var blocked bool
	var reason string
	for _, r := range results {
		switch v := r.(type) {
		case AsyncRegistrationVeto:
			if v.Block {
				blocked = true
				reason = v.Reason
			} else {
				// Explicit non-block clears any prior block — last
				// opinion wins, matching FireBeforePlanModeEnter.
				blocked = false
				reason = ""
			}
		case *AsyncRegistrationVeto:
			if v == nil {
				continue
			}
			if v.Block {
				blocked = true
				reason = v.Reason
			} else {
				blocked = false
				reason = ""
			}
		case map[string]interface{}:
			// JSON-RPC subprocess extensions hand us decoded maps.
			b, _ := v["block"].(bool)
			rs, _ := v["reason"].(string)
			if b {
				blocked = true
				reason = rs
			} else if _, present := v["block"]; present {
				// Explicit `block: false` — clear any prior veto.
				blocked = false
				reason = ""
			}
		}
	}
	if !blocked {
		return nil
	}
	if reason == "" {
		reason = "blocked by " + event + " hook"
	}
	return fmt.Errorf("%s", reason)
}
