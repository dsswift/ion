// session_accessor_messaging.go holds the sessionAccessor methods for
// cross-session notification/intercept broadcasting, session-to-session
// messaging, schedule control, run-once dedup, telemetry accessors, and
// plugin hook message building. Split out of session_accessor.go, which
// crossed the 800-line file cap; this is the file's most cohesive
// "messaging and side-channel" cluster and the one most likely to grow on
// its own (a new broadcast kind, a new plugin hook), independent of the
// core per-field accessors that remain in session_accessor.go.
package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/plugins"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (a *sessionAccessor) BroadcastNotification(opts types.NotifyOpts) {
	ev := types.EngineEvent{
		Type:             "engine_notification",
		Push:             true,
		PushTitle:        opts.Title,
		PushBody:         opts.Body,
		NotifyKind:       opts.Kind,
		NotifyResourceID: opts.ResourceID,
		NotifyTitle:      opts.Title,
		NotifyBody:       opts.Body,
		NotifySound:      opts.Sound,
		NotifyScope:      opts.Scope,
	}

	targetKey := opts.TargetSessionKey
	if targetKey != "" && targetKey != a.key {
		// Verify the target session exists.
		a.m.mu.RLock()
		_, exists := a.m.sessions[targetKey]
		a.m.mu.RUnlock()
		if exists {
			utils.LogWithFields(utils.LevelInfo, "session", "broadcastnotification: routing to target session (from )", map[string]any{"target_key": targetKey, "key": a.key})
			a.m.emit(targetKey, ev)
			return
		}
		utils.LogWithFields(utils.LevelWarn, "session", "broadcastnotification: target session not found, falling back to caller", map[string]any{"target_key": targetKey, "key": a.key})
	}

	a.m.emit(a.key, ev)
}

// BroadcastIntercept emits an engine_intercept event on the target session's
// stream. This is a fire-and-forget signal — the engine attaches no semantics
// beyond routing the event. When TargetSessionKey is set and the session
// exists, the event is emitted on that session's stream. Otherwise it falls
// back to the caller's session and a warning is logged.
func (a *sessionAccessor) BroadcastIntercept(opts extension.InterceptOpts) {
	ev := types.EngineEvent{
		Type:              "engine_intercept",
		InterceptLevel:    opts.Level,
		InterceptTitle:    opts.Title,
		InterceptMessage:  opts.Message,
		InterceptSource:   opts.Source,
		InterceptMetadata: opts.Metadata,
	}

	targetKey := opts.TargetSessionKey
	if targetKey != "" && targetKey != a.key {
		a.m.mu.RLock()
		_, exists := a.m.sessions[targetKey]
		a.m.mu.RUnlock()
		if exists {
			utils.LogWithFields(utils.LevelInfo, "session", "broadcastintercept: routing to target session (from )", map[string]any{"target_key": targetKey, "key": a.key})
			a.m.emit(targetKey, ev)
			return
		}
		utils.LogWithFields(utils.LevelWarn, "session", "broadcastintercept: target session not found, falling back to caller", map[string]any{"target_key": targetKey, "key": a.key})
	}

	a.m.emit(a.key, ev)
}

// ListAllSessions returns every engine session that shares the CALLING
// session's own principal (never every session engine-wide). Before this
// filter, an extension running in any one tenant's session on a shared
// multi-tenant engine could enumerate every other tenant's session key,
// conversation id, and extension name -- the SDK's own doc comment only ever
// promised "sessions of the same extension type", never cross-tenant
// visibility. A caller with no stamped principal (local/no-auth engine,
// where every session shares the same empty subject) sees the same
// unfiltered list it always did: the equality check is a no-op when both
// sides are "".
func (a *sessionAccessor) ListAllSessions() []extension.SessionListEntry {
	callerSubject := ""
	if p := a.Principal(); p != nil {
		callerSubject = p.Subject
	}

	infos := a.m.ListSessions()
	entries := make([]extension.SessionListEntry, 0, len(infos))
	for _, info := range infos {
		if info.PrincipalSubject != callerSubject {
			continue
		}
		entries = append(entries, extension.SessionListEntry{
			Key:              info.Key,
			HasActiveRun:     info.HasActiveRun,
			ExtensionName:    info.ExtensionName,
			ConversationID:   info.ConversationID,
			PrincipalSubject: info.PrincipalSubject,
		})
	}
	return entries
}

func (a *sessionAccessor) SendToSession(senderKey, targetKey, kind string, payload map[string]interface{}) error {
	a.m.mu.RLock()
	senderSession, senderOK := a.m.sessions[senderKey]
	targetSession, targetOK := a.m.sessions[targetKey]
	a.m.mu.RUnlock()

	if !targetOK {
		return fmt.Errorf("target session %q not found", targetKey)
	}
	if !senderOK {
		return fmt.Errorf("sender session %q not found", senderKey)
	}

	// Enforce same extension type.
	if senderSession.extensionName != targetSession.extensionName {
		return fmt.Errorf("cross-session messaging requires same extension type (sender=%q target=%q)",
			senderSession.extensionName, targetSession.extensionName)
	}

	// Check the target session has an extension group.
	if targetSession.extGroup == nil || targetSession.extGroup.IsEmpty() {
		return fmt.Errorf("target session %q has no extension group", targetKey)
	}

	// Fire the session_message hook on each host in the target session's
	// extension group, using the target session's context.
	info := extension.SessionMessageInfo{
		SenderSessionKey: senderKey,
		Kind:             kind,
		Payload:          payload,
	}

	ctx := a.m.newExtContext(targetSession, targetKey)
	for _, h := range targetSession.extGroup.Hosts() {
		if err := h.SDK().FireSessionMessage(ctx, info); err != nil {
			utils.LogWithFields(utils.LevelInfo, "session", "sendtosession: hook fire failed", map[string]any{"sender_key": senderKey, "target_key": targetKey, "kind": kind, "error": err})
		}
	}

	utils.LogWithFields(utils.LevelInfo, "session", "sendtosession: delivered", map[string]any{"sender_key": senderKey, "target_key": targetKey, "kind": kind})
	return nil
}

// FireSchedule triggers an immediate fire of the named schedule job.
func (a *sessionAccessor) FireSchedule(sessionKey, jobID string) error {
	return a.m.fireScheduleForSession(sessionKey, jobID)
}

// GetScheduleStatus returns status entries for registered schedule jobs.
func (a *sessionAccessor) GetScheduleStatus(sessionKey, jobID string) ([]extension.ScheduleStatusEntry, error) {
	return a.m.scheduleStatusForSession(sessionKey, jobID)
}

// RunOnceCheck delegates to the Manager's runOnce registry, scoped to this
// session's loaded extension directory.
func (a *sessionAccessor) RunOnceCheck(operationID string, debounceMs int64) (bool, string) {
	result := a.m.RunOnceCheck(a.key, operationID, debounceMs)
	return result.Execute, result.Reason
}

// RunOnceComplete delegates to the Manager's runOnce registry.
func (a *sessionAccessor) RunOnceComplete(operationID string, failed bool) {
	a.m.RunOnceComplete(a.key, operationID, failed)
}

// Telemetry returns the session's telemetry collector (nil when telemetry is
// disabled). Used by the dispatch path to emit dispatch.agent spans (family 4b).
func (a *sessionAccessor) Telemetry() *telemetry.Collector {
	return a.s.telemetry
}

// ConversationEventsTelemetry returns the standalone conversation.* telemetry
// collector (issue #378), or nil when conversation events are disabled. This
// is a separate, Manager-level collector from Telemetry() above — the two
// families gate independently (Manager.SetConversationEventsTelemetry /
// Server.SetConfig). The dispatched-child dispatch path (child 05) uses this
// to construct its own *telemetry.ConversationEmitter, mirroring how the root
// path (child 04) is expected to construct one from the same Manager method.
func (a *sessionAccessor) ConversationEventsTelemetry() *telemetry.Collector {
	return a.m.ConversationEventsTelemetry()
}

// PluginSessionMessages returns the pre-built <system-reminder> user messages
// from installed plugins' SessionStart hooks. These are set once at session
// start and prepended to the provider message slice on every turn (including
// dispatched child runs) so plugin instructions have full conversational
// attention weight regardless of system prompt length.
func (a *sessionAccessor) PluginSessionMessages() []types.LlmMessage {
	return a.s.pluginSessionMessages
}

// PluginTurnMessages fires all installed plugins' UserPromptSubmit hooks with
// the given prompt (passed via stdin as Claude Code JSON protocol) and returns
// the resulting <system-reminder>-wrapped user messages. Called per turn by the
// dispatch path to produce per-turn plugin reinforcement for dispatched agents.
func (a *sessionAccessor) PluginTurnMessages(prompt string) []types.LlmMessage {
	if len(a.s.pluginUserPromptHooks) == 0 {
		return nil
	}
	stdinPayload := buildPromptStdinPayload(prompt)
	var msgs []types.LlmMessage
	for _, cmd := range a.s.pluginUserPromptHooks {
		out, err := plugins.RunHookCommandWithStdin(cmd.Entry, cmd.PluginRoot, nil, stdinPayload)
		if err == nil {
			if ctx := plugins.ParseHookOutput(out); ctx != "" {
				msgs = append(msgs, types.LlmMessage{
					Role:    "user",
					Content: wrapInSystemReminder("UserPromptSubmit hook additional context: " + ctx),
				})
			}
		}
	}
	return msgs
}
