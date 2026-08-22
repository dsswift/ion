package session

import (
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// background_task_wake.go is the session-layer revive driver for background
// bash commands — the root-session counterpart to runChild's revive loop.
//
// The two differ by necessity. A dispatched child parks a LIVE goroutine
// blocked on reviveCh (dispatch_registry_suspend.go), so reviving it is a
// channel send. A root session has no such goroutine: its run exits fully at
// the turn boundary, the backend forgets the requestID, and the session goes
// idle. Reviving the root therefore means STARTING A NEW RUN with the
// completion injected as its prompt — which is the same mechanism an
// extension's ctx.sendPrompt already uses, reached through SendPrompt +
// emitPromptInjected.
//
// Wake is per-completion, not wait-for-all. Dispatch's PendingChildren revives
// only when the whole set drains; here each completion wakes the session with
// that task's result plus whatever remains outstanding, because a finished
// command may unblock work the model can do while the others still run. If the
// woken run ends its turn with tasks still outstanding, the turn-boundary park
// check parks it again. That cycle repeats until the set empties.

// BackgroundTaskCompletionInjectionKind classifies a wake prompt carrying a
// background command's result. It marks a machine-to-machine injection rather
// than a user-authored turn, so consumers can render or filter it accordingly.
//
// Aliases types.InjectionKindBackgroundTaskCompletion — the enumerated set in
// types/injection_kind.go is the definition.
const BackgroundTaskCompletionInjectionKind = string(types.InjectionKindBackgroundTaskCompletion)

// parkedRun records that a session's run exited at a turn boundary because it
// had outstanding background commands, and is waiting to be woken.
type parkedRun struct {
	// TaskIDs is the outstanding set at the moment of parking, for logging
	// and for the timeout payload. The authoritative set remains
	// engineSession.outstandingBackgroundTasks.
	TaskIDs []string
	// ParkedAt is when the run exited into the parked state.
	ParkedAt time.Time
	// TimeoutTimer fires when ParkTimeoutMs elapses without the session being
	// woken, so a command that never exits cannot strand the session forever.
	// Stopped when a wake claims the park.
	TimeoutTimer *time.Timer
}

// backgroundCompletionPayload is a completion held for later delivery under
// the "queue" mode.
type backgroundCompletionPayload struct {
	Text       string
	ReceivedAt time.Time
}

// wireBackgroundTaskNotifier installs this manager as the process-wide
// background-task completion notifier. Called once during manager
// construction. The tools package holds only a function value, which is what
// keeps internal/tools free of a session import.
func (m *Manager) wireBackgroundTaskNotifier() {
	tools.SetTaskCompletionNotifier(m.onBackgroundTaskComplete)
	utils.Log("session.bgtask", "background task completion notifier installed")
}

// onBackgroundTaskComplete is the terminal handler for a notifying background
// bash command. It runs on the tools package's watcher goroutine.
//
// Two obligations, in order and independent of each other:
//
//  1. SIGNAL — emit the typed event and fire the extension hook. This happens
//     for every completion regardless of delivery mode, because the typed
//     event is the engine's complete signaling surface (engine-grounding §3).
//  2. DELIVER — route the result into the session according to the configured
//     delivery mode. This is the opinion, and it is what a consumer can turn
//     off without losing the signal.
func (m *Manager) onBackgroundTaskComplete(c tools.TaskCompletion) {
	key := c.Owner
	if key == "" {
		utils.LogWithFields(utils.LevelWarn, "session.bgtask", "completion has no owning session; dropping delivery", map[string]any{
			"task_id": c.TaskID, "status": c.Status,
		})
		return
	}

	// Drain the task from the outstanding set and decide, under a single lock
	// hold, whether THIS completion owns the wake. Two commands finishing at
	// the same instant must not start two runs: the first claims the park, the
	// second sees it already claimed and routes to the mid-turn steer path.
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.bgtask", "completion for a session that no longer exists; dropping", map[string]any{
			"task_id": c.TaskID, "session_id": key, "status": c.Status,
		})
		return
	}
	remaining, tracked := drainOutstandingBackgroundTaskLocked(s, c.TaskID)
	registry := s.dispatchRegistry
	runActive := s.requestID != ""
	// A task a parked dispatch is waiting on does not wake the root: the
	// dispatch consumes it. Claiming the root's park here would clear the
	// park record (and its timeout) for a completion the root never sees.
	// Probed under the same lock as the drain; the authoritative routing
	// decision is DeliverTaskResult's return below, which falls back to the
	// root paths if the dispatch went away in between.
	dispatchOwner := ""
	if registry != nil {
		dispatchOwner = registry.PendingTaskOwner(c.TaskID)
	}
	claimedPark := false
	if s.parked != nil && !runActive && dispatchOwner == "" {
		// This completion wakes the parked session. Clear the park under the
		// same lock that drained the task so a concurrent completion cannot
		// also claim it.
		if s.parked.TimeoutTimer != nil {
			s.parked.TimeoutTimer.Stop()
		}
		s.parked = nil
		claimedPark = true
	}
	m.mu.Unlock()

	remainingIDs := make([]string, 0, len(remaining))
	for _, t := range remaining {
		remainingIDs = append(remainingIDs, t.TaskID)
	}

	utils.LogWithFields(utils.LevelInfo, "session.bgtask", "background task completion received", map[string]any{
		"task_id": c.TaskID, "session_id": key, "status": c.Status, "exit_code": c.ExitCode,
		"tracked": tracked, "run_active": runActive, "claimed_park": claimedPark,
		"remaining": len(remainingIDs), "dispatch_id": dispatchOwner,
	})

	// ── Obligation 1: signal ────────────────────────────────────────────────
	m.emitBackgroundTaskComplete(key, c, remainingIDs)
	m.fireBackgroundTaskCompletedHook(key, c, remainingIDs)
	// The outstanding-shell count changed; refresh status so consumers stop
	// showing this task as in flight.
	m.emitBackgroundShellStatus(key, "background_task_completed")

	if !tracked {
		// Not part of the outstanding set (started without notify_on_complete
		// tracking, or registered past the cap). The signal above is the whole
		// obligation; nothing is waiting on it, so no delivery.
		utils.LogWithFields(utils.LevelDebug, "session.bgtask", "completion not tracked as outstanding; signal only", map[string]any{
			"task_id": c.TaskID, "session_id": key,
		})
		return
	}

	// ── Obligation 2: deliver ───────────────────────────────────────────────
	mode := m.backgroundTasksConfig().Delivery
	payload := buildBackgroundWakePayload(c, remaining)

	// A dispatched agent that started this command and then suspended is
	// parked on it. Task ownership is session-scoped, so the completion
	// arrives here rather than at the dispatch — routing it to the root
	// instead would leave the dispatch (and every ancestor parked on it)
	// blocked on a signal that never comes. Deliver to the owning dispatch
	// and stop: the root learns the outcome through that dispatch's own
	// completion. An empty owner means no parked dispatch awaits the task, so
	// the root paths below run exactly as before.
	if registry != nil {
		owner, revived := registry.DeliverTaskResult(c.TaskID, extcontext.TaskResultRecord{
			Status:   c.Status,
			ExitCode: c.ExitCode,
			Payload:  payload,
		})
		if owner != "" {
			utils.LogWithFields(utils.LevelInfo, "session.bgtask", "completion delivered to parked dispatch", map[string]any{
				"task_id": c.TaskID, "session_id": key, "delivery": "dispatch_revive",
				"dispatch_id": owner, "revived": revived,
			})
			return
		}
		utils.LogWithFields(utils.LevelDebug, "session.bgtask", "no parked dispatch awaits this task; routing to session", map[string]any{
			"task_id": c.TaskID, "session_id": key,
		})
	}

	if runActive {
		// The orchestrator is mid-turn. Steer the result in so it lands at the
		// next drainSteer checkpoint without interrupting the run.
		outcome := m.SteerAgent(key, "", payload)
		utils.LogWithFields(utils.LevelInfo, "session.bgtask", "completion delivered to active run via steer", map[string]any{
			"task_id": c.TaskID, "session_id": key, "delivery": "steer", "outcome": outcome.String(),
		})
		if outcome.Delivered() {
			return
		}
		// The run ended between the status read and the steer. Fall through to
		// the idle paths rather than dropping the completion.
		utils.LogWithFields(utils.LevelInfo, "session.bgtask", "steer not delivered; falling through to idle delivery", map[string]any{
			"task_id": c.TaskID, "session_id": key, "outcome": outcome.String(),
		})
	}

	switch mode {
	case types.BackgroundDeliveryEventOnly:
		utils.LogWithFields(utils.LevelInfo, "session.bgtask", "delivery suppressed by configuration", map[string]any{
			"task_id": c.TaskID, "session_id": key, "delivery": mode,
		})
		return

	case types.BackgroundDeliveryQueue:
		m.mu.Lock()
		if s2, ok := m.sessions[key]; ok {
			s2.pendingBackgroundCompletions = append(s2.pendingBackgroundCompletions, backgroundCompletionPayload{
				Text: payload, ReceivedAt: time.Now(),
			})
		}
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.bgtask", "completion queued for next run", map[string]any{
			"task_id": c.TaskID, "session_id": key, "delivery": mode,
		})
		return

	default: // types.BackgroundDeliveryWake
		m.wakeSessionWithPayload(key, c.TaskID, payload, mode)
	}
}

// wakeSessionWithPayload starts a fresh run carrying the wake payload as its
// injected prompt. This is the root-session revive: unlike a dispatched child
// there is no parked goroutine to signal, so the session resumes by running
// again with the completion in its conversation.
func (m *Manager) wakeSessionWithPayload(key, taskID, payload, mode string) {
	overrides := buildPromptOverrides("", nil, BackgroundTaskCompletionInjectionKind)
	if err := m.SendPrompt(key, payload, overrides); err != nil {
		utils.LogWithFields(utils.LevelError, "session.bgtask", "wake failed: could not start run for completion", map[string]any{
			"task_id": taskID, "session_id": key, "delivery": mode, "error": err.Error(),
		})
		// The run could not start (queue full, session tearing down). Hold the
		// payload so the next run that does start still carries the result
		// rather than losing it silently.
		m.mu.Lock()
		if s, ok := m.sessions[key]; ok {
			s.pendingBackgroundCompletions = append(s.pendingBackgroundCompletions, backgroundCompletionPayload{
				Text: payload, ReceivedAt: time.Now(),
			})
		}
		m.mu.Unlock()
		return
	}
	m.emitPromptInjected(key, payload, BackgroundTaskCompletionInjectionKind)
	utils.LogWithFields(utils.LevelInfo, "session.bgtask", "session woken with completion", map[string]any{
		"task_id": taskID, "session_id": key, "delivery": mode,
	})
}

// buildBackgroundWakePayload renders the prompt text delivered to the model.
// Deliberately minimal and factual — the engine states what happened and what
// is still outstanding, and takes no position on what the model should do
// next. A harness that wants different prose overrides delivery via the
// background_task_completed hook.
func buildBackgroundWakePayload(c tools.TaskCompletion, remaining []outstandingBackgroundTask) string {
	var b strings.Builder

	fmt.Fprintf(&b, "Background command %s (%s).\n", c.TaskID, c.Status)
	fmt.Fprintf(&b, "Command: %s\n", c.Command)
	fmt.Fprintf(&b, "Exit code: %d\n", c.ExitCode)
	fmt.Fprintf(&b, "Elapsed: %dms\n", c.ElapsedMs)
	if c.OutputPath != "" {
		fmt.Fprintf(&b, "Output file: %s\n", c.OutputPath)
	}
	if c.Tail != "" {
		fmt.Fprintf(&b, "Recent output:\n%s\n", c.Tail)
	}

	if len(remaining) == 0 {
		b.WriteString("\nNo background commands remain outstanding.")
		return b.String()
	}
	fmt.Fprintf(&b, "\nStill running (%d):\n", len(remaining))
	for _, t := range remaining {
		fmt.Fprintf(&b, "- %s: %s\n", t.TaskID, t.Command)
	}
	return strings.TrimRight(b.String(), "\n")
}

// emitBackgroundTaskComplete emits the typed wire event for a completion.
func (m *Manager) emitBackgroundTaskComplete(key string, c tools.TaskCompletion, remainingIDs []string) {
	m.emit(key, types.EngineEvent{
		Type: "engine_background_task_complete",
		BackgroundTaskComplete: &types.BackgroundTaskCompletePayload{
			TaskID:           c.TaskID,
			Status:           c.Status,
			ExitCode:         c.ExitCode,
			ElapsedMs:        c.ElapsedMs,
			OutputPath:       c.OutputPath,
			Tail:             c.Tail,
			Command:          c.Command,
			RemainingTaskIDs: remainingIDs,
		},
	})
}

// fireBackgroundTaskCompletedHook notifies extensions of a completion. Fired
// for every notifying task regardless of delivery mode, so a harness observes
// completions even when the engine is configured not to start runs.
func (m *Manager) fireBackgroundTaskCompletedHook(key string, c tools.TaskCompletion, remainingIDs []string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return
	}
	extGroup := s.extGroup
	if extGroup == nil || extGroup.IsEmpty() {
		utils.LogWithFields(utils.LevelDebug, "session.bgtask", "no extensions to notify of completion", map[string]any{
			"task_id": c.TaskID, "session_id": key,
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session.bgtask", "firing background_task_completed", map[string]any{
		"task_id": c.TaskID, "session_id": key, "status": c.Status,
	})
	extGroup.FireBackgroundTaskCompleted(m.newExtContext(s, key), extension.BackgroundTaskCompletedInfo{
		TaskID:           c.TaskID,
		SessionKey:       key,
		Command:          c.Command,
		Status:           c.Status,
		ExitCode:         c.ExitCode,
		ElapsedMs:        c.ElapsedMs,
		OutputPath:       c.OutputPath,
		Tail:             c.Tail,
		RemainingTaskIDs: remainingIDs,
	})
}

// clearParkedStateLocked drops any park record on the session. Caller MUST
// hold m.mu.
//
// A park record means "this session's run ended with work outstanding and is
// waiting to be woken." The instant any run starts that is no longer true: the
// session is running, and a completion arriving now must take the mid-turn
// steer path rather than claiming a park nothing is waiting on.
//
// Called from the run-start seam (SendPrompt, under the same lock that assigns
// requestID) so park state and run state can never disagree. This matters
// because handleRunExit drains a queued prompt on the SAME exit that records
// the park — the park path routes through it deliberately, see
// parkForBackgroundTasks — so a session with a queued prompt parks and
// immediately starts running. Without this clear, a completion arriving in that
// window would claim the stale park and start a second concurrent run.
//
// reason is an observability label naming what started the run.
func clearParkedStateLocked(s *engineSession, key, reason string) {
	if s.parked == nil {
		return
	}
	awaited := len(s.parked.TaskIDs)
	if s.parked.TimeoutTimer != nil {
		s.parked.TimeoutTimer.Stop()
	}
	s.parked = nil
	utils.LogWithFields(utils.LevelInfo, "session.bgtask", "park cleared: a run started on the session", map[string]any{
		"session_id": key, "was_awaiting": awaited, "reason": reason,
	})
}

// markSessionParked records that a run exited into the parked state and arms
// the park timeout. Called when the run loop reports a turn-boundary park via
// TaskSuspendEvent carrying task IDs.
func (m *Manager) markSessionParked(key string, taskIDs []string) {
	cfg := m.backgroundTasksConfig()
	timeout := time.Duration(cfg.ParkTimeoutMs) * time.Millisecond

	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session.bgtask", "park recorded for unknown session", map[string]any{
			"session_id": key, "count": len(taskIDs),
		})
		return
	}
	if s.parked != nil && s.parked.TimeoutTimer != nil {
		// Re-parking (the woken run ended its turn with work still
		// outstanding). Replace the previous timer rather than leaking it.
		s.parked.TimeoutTimer.Stop()
	}
	timer := time.AfterFunc(timeout, func() { m.onParkTimeout(key) })
	s.parked = &parkedRun{TaskIDs: taskIDs, ParkedAt: time.Now(), TimeoutTimer: timer}
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session.bgtask", "session parked on outstanding background commands", map[string]any{
		"session_id": key, "count": len(taskIDs), "task_ids": taskIDs, "timeout_ms": cfg.ParkTimeoutMs,
	})
	m.emitBackgroundShellStatus(key, "session_parked")
}

// onParkTimeout releases a park whose outstanding commands have not finished
// within ParkTimeoutMs. The tasks REMAIN outstanding: a command that is merely
// slow still notifies when it eventually exits. The timeout exists so a wedged
// command cannot strand the session indefinitely, not to abandon the work.
//
// Whether the release also starts a run is the operator's opinion, read from
// the same backgroundTasks.delivery field onBackgroundTaskComplete honors. The
// park is always cleared — leaving a session wedged is never a delivery
// policy — but `event_only` and `queue` suppress the unattended run, because
// event_only is documented as the off switch for exactly that.
func (m *Manager) onParkTimeout(key string) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok || s.parked == nil {
		m.mu.Unlock()
		return
	}
	stuck := outstandingSnapshotLocked(s)
	parkedFor := time.Since(s.parked.ParkedAt)
	s.parked = nil
	m.mu.Unlock()

	mode := m.backgroundTasksConfig().Delivery
	if mode != types.BackgroundDeliveryWake {
		// Park released so the session is not wedged, but no run starts: the
		// operator configured the engine not to begin work unattended.
		utils.LogWithFields(utils.LevelWarn, "session.bgtask", "park timeout elapsed; park released without starting a run per delivery configuration", map[string]any{
			"session_id": key, "count": len(stuck), "parked_ms": parkedFor.Milliseconds(),
			"delivery": mode,
		})
		m.emitBackgroundShellStatus(key, "park_timeout_suppressed")
		return
	}

	utils.LogWithFields(utils.LevelWarn, "session.bgtask", "park timeout elapsed; waking session with outstanding commands still running", map[string]any{
		"session_id": key, "count": len(stuck), "parked_ms": parkedFor.Milliseconds(),
		"delivery": mode,
	})

	var b strings.Builder
	fmt.Fprintf(&b, "Background commands have not finished after %s.\n", parkedFor.Round(time.Second))
	if len(stuck) == 0 {
		b.WriteString("No commands are outstanding; the session resumed.")
	} else {
		fmt.Fprintf(&b, "Still running (%d):\n", len(stuck))
		for _, t := range stuck {
			fmt.Fprintf(&b, "- %s: %s\n", t.TaskID, t.Command)
		}
		b.WriteString("These commands remain tracked and will report when they finish.")
	}
	m.wakeSessionWithPayload(key, "park-timeout", strings.TrimRight(b.String(), "\n"), "wake_timeout")
}

// takePendingBackgroundCompletions removes and returns any queued completions
// for the session. Called at run start so queued results ride along with the
// next run rather than waiting for another completion.
func (m *Manager) takePendingBackgroundCompletions(key string) []backgroundCompletionPayload {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	if !ok || len(s.pendingBackgroundCompletions) == 0 {
		return nil
	}
	out := s.pendingBackgroundCompletions
	s.pendingBackgroundCompletions = nil
	utils.LogWithFields(utils.LevelInfo, "session.bgtask", "draining queued background completions into run", map[string]any{
		"session_id": key, "count": len(out),
	})
	return out
}

// backgroundTaskParkable is the local interface satisfied by any backend that
// can park an active run on its outstanding background bash commands.
// *ApiBackend implements it directly; *HybridBackend forwards to the inner
// backend recorded for the requestID, so an api-routed hybrid run resolves.
// Delegated-CLI backends and test stubs do not implement it, and ParkMainLoop
// refuses for them.
//
// This local interface is the mechanism that keeps SignalParkForBackgroundTasks
// off the public RunBackend interface — adding it there would be a contract
// change. Mirrors the compactable pattern in command_dispatch.go and the
// steerable pattern in agent.go.
type backgroundTaskParkable interface {
	SignalParkForBackgroundTasks(requestID string, taskIDs []string) bool
}

// ParkMainLoop parks the session's active main run on its outstanding
// background bash commands, ending the run without completing it.
//
// This is the depth-0 counterpart to a dispatched child's ctx.suspend(). The
// difference is structural: a child's suspend parks a live runChild goroutine
// that later resumes on reviveCh, whereas the root's run exits entirely and is
// revived by starting a NEW run when a command completes (see
// onBackgroundTaskComplete). Reached from the extension surface via
// ctx.Suspend at depth 0; the engine's automatic turn-boundary park does not
// route through here (the run loop already holds the run it is parking).
//
// Returns false when there is no active run to park, when the backend is not
// API-routed, or when nothing is outstanding — parking a session with no
// in-flight work would strand it until the park timeout, so it is refused.
func (m *Manager) ParkMainLoop(key string) bool {
	outstanding := m.OutstandingBackgroundTaskIDs(key)
	if len(outstanding) == 0 {
		utils.LogWithFields(utils.LevelWarn, "session.bgtask", "park refused: no outstanding background commands", map[string]any{
			"session_id": key,
		})
		return false
	}

	m.mu.RLock()
	s, ok := m.sessions[key]
	rid := ""
	if ok {
		rid = s.requestID
	}
	m.mu.RUnlock()
	if !ok || rid == "" {
		utils.LogWithFields(utils.LevelWarn, "session.bgtask", "park refused: no active run", map[string]any{
			"session_id": key, "session_exists": ok, "count": len(outstanding),
		})
		return false
	}

	parker, ok := m.backend.(backgroundTaskParkable)
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "session.bgtask", "park refused: backend does not support parking", map[string]any{
			"session_id": key, "run_id": rid, "backend": fmt.Sprintf("%T", m.backend),
		})
		return false
	}
	if !parker.SignalParkForBackgroundTasks(rid, outstanding) {
		utils.LogWithFields(utils.LevelWarn, "session.bgtask", "park signal not accepted by backend", map[string]any{
			"session_id": key, "run_id": rid, "count": len(outstanding),
		})
		return false
	}
	utils.LogWithFields(utils.LevelInfo, "session.bgtask", "park signalled for main run", map[string]any{
		"session_id": key, "run_id": rid, "count": len(outstanding), "task_ids": outstanding,
	})
	return true
}
