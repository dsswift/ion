package extcontext

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatch_park_checkin.go owns the wait a parked dispatch blocks in, and the
// periodic check-in that can end that wait early.
//
// A parked dispatch normally sleeps until its awaited work settles. A
// dispatcher that declared DispatchAgentOpts.ParkCheckInIntervalMs instead
// gets the dispatch woken for one turn every interval, so the agent can look
// at the work it is waiting on and steer, recall, or leave it. The woken run
// is an ordinary run: when it ends its turn with the work still outstanding,
// the turn-boundary park puts it back to sleep and a fresh wait begins.

// parkWakeReason says why a parked dispatch stopped waiting.
type parkWakeReason string

const (
	// parkWakeRevived: the awaited work settled and signalled the revive.
	parkWakeRevived parkWakeReason = "revived"
	// parkWakeCheckIn: a check-in interval elapsed and produced a prompt.
	parkWakeCheckIn parkWakeReason = "checkin"
	// parkWakeRecalled: the dispatch was cancelled while parked.
	parkWakeRecalled parkWakeReason = "recalled"
	// parkWakeTimedOut: the park ceiling elapsed with no revive.
	parkWakeTimedOut parkWakeReason = "timed_out"
)

// parkWake is the outcome of one park wait. prompt is set only for
// parkWakeCheckIn.
type parkWake struct {
	reason parkWakeReason
	prompt string
}

// parkWait is one park's wait: the channels that end it, the ceiling that
// bounds it, and the optional check-in.
type parkWait struct {
	reviveCh <-chan struct{}
	recalled <-chan struct{}
	// timeout is the park ceiling: the backstop for a lost or misrouted wake,
	// which would otherwise block on reviveCh forever and strand every
	// ancestor parked on this dispatch. See dispatchParkTimeout.
	timeout time.Duration
	// checkInInterval is the check-in period; zero disables check-ins.
	checkInInterval time.Duration
	// ask resolves the check-in prompt from the dispatcher. Nil means the
	// engine's generic prompt.
	ask func(extension.DispatchParkCheckInInfo) (extension.DispatchParkCheckInReply, error)
	// claim takes the park away from the revive path so the check-in and a
	// concurrent revive cannot both resume the dispatch. False means a revive
	// was already signalled and must win.
	claim func() bool
	// awaiting reads the live state of the awaited child dispatches at a
	// tick. Nil means no registry to read.
	awaiting func() []extension.DispatchStateEntry
	// info is the check-in payload minus the per-tick fields.
	info extension.DispatchParkCheckInInfo
}

// newParkWait builds the wait for a dispatch that just parked on sig.
func newParkWait(ctx context.Context, sa SessionAccessor, registry *DispatchRegistry, opts *extension.DispatchAgentOpts, dispatchID string, depth int, reviveCh <-chan struct{}, sig *types.TaskSuspendEvent) parkWait {
	w := parkWait{
		reviveCh:        reviveCh,
		recalled:        ctx.Done(),
		timeout:         dispatchParkTimeout(sa),
		checkInInterval: time.Duration(opts.ParkCheckInIntervalMs) * time.Millisecond,
		ask:             opts.OnParkCheckIn,
		claim:           func() bool { return true },
		info: extension.DispatchParkCheckInInfo{
			Name:                opts.Name,
			DispatchID:          dispatchID,
			Depth:               depth,
			AwaitingDispatchIDs: sig.AwaitingDispatchIDs,
			AwaitingTaskIDs:     sig.AwaitingTaskIDs,
			AwaitingPollIDs:     sig.AwaitingPollIDs,
		},
	}
	if registry != nil {
		w.claim = func() bool { return registry.ClaimParkForCheckIn(dispatchID) }
		awaitedIDs := sig.AwaitingDispatchIDs
		w.awaiting = func() []extension.DispatchStateEntry {
			snap := registry.SnapshotOf(awaitedIDs)
			entries := make([]extension.DispatchStateEntry, len(snap))
			for i, s := range snap {
				entries[i] = mapDispatchStateEntry(s)
			}
			return entries
		}
	}
	return w
}

// wait blocks until the park ends and reports why.
func (w parkWait) wait() parkWake {
	parkedAt := time.Now()
	ceiling := time.NewTimer(w.timeout)
	defer ceiling.Stop()

	// A nil channel never fires, so a dispatch with no declared interval
	// waits exactly as it did before check-ins existed.
	var tick <-chan time.Time
	var ticker *time.Timer
	if w.checkInInterval > 0 {
		ticker = time.NewTimer(w.checkInInterval)
		defer ticker.Stop()
		tick = ticker.C
	}

	count := 0
	for {
		select {
		case <-w.reviveCh:
			return parkWake{reason: parkWakeRevived}
		case <-w.recalled:
			return parkWake{reason: parkWakeRecalled}
		case <-ceiling.C:
			return parkWake{reason: parkWakeTimedOut}
		case <-tick:
			count++
			info := w.info
			info.ParkedMs = time.Since(parkedAt).Milliseconds()
			info.CheckInCount = count
			if w.awaiting != nil {
				info.AwaitingDispatches = w.awaiting()
			}
			fields := map[string]any{
				"dispatch_id":   info.DispatchID,
				"model":         info.Name,
				"checkin_count": count,
				"parked_ms":     info.ParkedMs,
			}
			prompt, ok := w.resolvePrompt(info, fields)
			if !ok {
				ticker.Reset(w.checkInInterval)
				continue
			}
			if !w.claim() {
				// The awaited work settled while the prompt was being
				// resolved. Its revive is already in reviveCh; the next
				// iteration takes it.
				utils.LogWithFields(utils.LevelInfo, "server", "dispatch park check-in dropped: revive already signalled", fields)
				continue
			}
			fields["count"] = len(prompt)
			utils.LogWithFields(utils.LevelInfo, "server", "dispatch park check-in waking parked dispatch", fields)
			return parkWake{reason: parkWakeCheckIn, prompt: prompt}
		}
	}
}

// resolvePrompt returns the prompt for one check-in tick, or false when this
// tick delivers nothing and the dispatch stays parked.
func (w parkWait) resolvePrompt(info extension.DispatchParkCheckInInfo, fields map[string]any) (string, bool) {
	if w.ask == nil {
		return buildDefaultParkCheckInPrompt(info), true
	}
	reply, err := w.ask(info)
	if err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelWarn, "server", "dispatch park check-in skipped: dispatcher did not answer", fields)
		delete(fields, "error")
		return "", false
	}
	if reply.Skip || reply.Prompt == "" {
		utils.LogWithFields(utils.LevelInfo, "server", "dispatch park check-in skipped by dispatcher", fields)
		return "", false
	}
	return reply.Prompt, true
}

// buildDefaultParkCheckInPrompt is the engine's generic check-in prompt, used
// when the dispatcher declared an interval but supplies no prompt of its own.
func buildDefaultParkCheckInPrompt(info extension.DispatchParkCheckInInfo) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[SYSTEM] Park check-in. You have been parked for %s waiting on work you started, and it has not finished yet.\n", time.Duration(info.ParkedMs)*time.Millisecond)
	writeAwaited := func(label string, ids []string) {
		if len(ids) > 0 {
			fmt.Fprintf(&b, "\n%s: %s", label, strings.Join(ids, ", "))
		}
	}
	if len(info.AwaitingDispatches) > 0 {
		b.WriteString("\nDispatched agents still running:")
		for _, d := range info.AwaitingDispatches {
			fmt.Fprintf(&b, "\n- %s (dispatch %s): running %s, %d tool calls, last activity %s ago", d.Name, d.DispatchID,
				(time.Duration(d.ElapsedMs) * time.Millisecond).Round(time.Second), d.ToolCount,
				(time.Duration(d.LastActivityMs) * time.Millisecond).Round(time.Second))
			if d.LastWork != "" {
				fmt.Fprintf(&b, ": %s", d.LastWork)
			}
		}
	} else {
		writeAwaited("Dispatched agents", info.AwaitingDispatchIDs)
	}
	writeAwaited("Background commands", info.AwaitingTaskIDs)
	writeAwaited("Polls", info.AwaitingPollIDs)
	b.WriteString("\n\nInspect that work if you need to. Its results will be delivered to you when it finishes; end your turn to keep waiting. Do NOT restart your task — your earlier work is in this conversation.")
	return b.String()
}

// SnapshotOf returns the live state of the dispatches named by ids, in the
// order given. A dispatch that already finished is absent. Thread-safe.
func (r *DispatchRegistry) SnapshotOf(ids []string) []DispatchStateEntry {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	entries := make([]DispatchStateEntry, 0, len(ids))
	for _, id := range ids {
		if d, ok := r.dispatches[id]; ok && !d.reserved {
			entries = append(entries, snapshotEntryLocked(d, now))
		}
	}
	return entries
}

// ClaimParkForCheckIn ends a dispatch's park on behalf of a check-in. It
// succeeds only while the park is still armed: once a revive has been
// signalled the entry's ReviveCh is already cleared, the claim fails, and the
// revive wins. A successful claim clears the suspended state so the resumed
// run reads as running and a later completion is recorded rather than
// signalled into a wait nobody is in. Thread-safe.
func (r *DispatchRegistry) ClaimParkForCheckIn(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.dispatches[id]
	if !ok || d.ReviveCh == nil {
		return false
	}
	d.ReviveCh = nil
	d.PendingChildren = nil
	d.PendingTasks = nil
	d.PendingPolls = nil
	d.Suspended = false
	return true
}
