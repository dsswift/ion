package backend

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SteerResult is the typed verdict of a steer-delivery attempt against an
// API-backed run. It replaces the bare bool returned by Steer so callers can
// distinguish "no such run" from "channel full" — the two failure modes have
// very different remedies and the historical bare-bool collapsed both into a
// silent false. This is an internal backend type, not a wire/SDK contract;
// the wire-facing Steer(...) bool method is retained unchanged for any
// caller that only needs the boolean. See docs/engine-grounding.md §7.
type SteerResult int

const (
	// SteerResultDelivered: the message was buffered on the run's steer
	// channel and will be injected at the next drainSteer checkpoint.
	SteerResultDelivered SteerResult = iota
	// SteerResultNoRun: no active run matched the requestID.
	SteerResultNoRun
	// SteerResultChannelFull: the run exists but its steer channel was full.
	SteerResultChannelFull
)

// String renders a SteerResult for logs.
func (r SteerResult) String() string {
	switch r {
	case SteerResultDelivered:
		return "delivered"
	case SteerResultNoRun:
		return "no_run"
	case SteerResultChannelFull:
		return "channel_full"
	default:
		return "unknown"
	}
}

// steerMessage is one buffered steer: the text plus the classification of who
// authored it.
//
// The kind rides WITH the message rather than being resolved at the drain
// point, because only the caller knows where the steer came from. A human
// typing into a running turn and a harness bubbling a dispatch completion into
// that same turn arrive through the identical channel and are indistinguishable
// once buffered. The channel used to be a bare `chan string`, so drainSteer had
// nowhere to read a kind from and persisted every steer — including a
// machine-to-machine one — as an unclassified user turn.
//
// Internal to the backend; not a wire or SDK type.
type steerMessage struct {
	text string
	// kind is a types.InjectionKind wire value. Empty for a client-originated
	// steer, which is a genuine user turn.
	kind string
	// clientMessageID is the client-supplied correlation id from a steer_agent
	// command's optional ClientMessageID field. Empty for a machine-originated
	// steer (kind != "") and for any client that omitted the field. Carried
	// through so drainSteer can echo it back on the confirming
	// engine_steer_injected event — the only way a client's own optimistic UI
	// row can be re-keyed by identity instead of assumed-first-pending-row
	// position, which breaks the moment more than one steer is outstanding or
	// a machine injection interleaves with a human one.
	clientMessageID string
	backgroundWork  *types.BackgroundWorkInfo
}

// drainSteer performs a non-blocking check of the run's steer channel.
// If a steer message is present it is injected into the conversation as a
// user message, persisted, logged, and a SteerInjectedEvent is emitted so
// clients can confirm the steer was captured. Returns true when a steer
// was consumed; false when the channel is empty.
//
// Call sites:
//   - Top of each agent-loop iteration (replaces the inline select): catches
//     steers that arrive between turns.
//   - Before end_turn/stop exit: converts an in-flight steer into a forced
//     continuation instead of letting the session layer start a new run.
//   - After tool results are saved: catches steers that arrived during
//     potentially long tool-execution phases before the next LLM call.
func (b *ApiBackend) drainSteer(run *activeRun, conv *conversation.Conversation) bool {
	select {
	case steerMsg := <-run.steerCh:
		// Classified through the kind-aware append so a machine-originated
		// steer persists as the machine-to-machine turn it is. A client steer
		// carries no kind and reaches the same plain user turn as before.
		var entry *conversation.SessionEntry
		if steerMsg.backgroundWork != nil {
			entry = conversation.AddUserMessageWithBackgroundWork(conv, steerMsg.text, *steerMsg.backgroundWork)
		} else {
			entry = conversation.AddUserMessageWithKind(conv, steerMsg.text, steerMsg.kind)
		}
		// Persist a steer marker immediately after the injected user message so
		// the steer marker survives reload (SteerInjectedEvent is not persisted).
		// Appended before the existing Save so it rides the same write.
		if conv.Entries != nil {
			conversation.AppendEntry(conv, conversation.EntrySteerMarker, conversation.SteerMarkerData{
				MessageLength: len(steerMsg.text),
			})
		}
		if err := conversation.Save(conv, ""); err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation after steer injection", map[string]any{
				"run_id": run.requestID,
				"error":  utils.ErrStr(err),
			})
		}
		// entryID and clientID are only echoed when this was a genuine
		// client-originated steer (no kind) — a machine-to-machine injection
		// (kind != "") must never resolve a client's optimistic UI row, even
		// if a caller mistakenly supplied a clientMessageID alongside a
		// non-empty kind. A client that sent no correlation id still gets
		// entryID (this remains a genuine client steer) but an empty
		// clientID, preserving the pre-existing length-only confirmation
		// shape for callers that have not adopted correlation ids.
		var entryID, clientID string
		if steerMsg.kind == "" {
			clientID = steerMsg.clientMessageID
			if entry != nil {
				entryID = entry.ID
			}
		}
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "steer message injected into conversation", map[string]any{
			"run_id":            run.requestID,
			"msg_len":           len(steerMsg.text),
			"kind":              steerMsg.kind,
			"client_message_id": clientID,
			"entry_id":          entryID,
		})
		b.emit(run, types.NormalizedEvent{Data: &types.SteerInjectedEvent{
			MessageLength:   len(steerMsg.text),
			ClientMessageID: clientID,
			EntryID:         entryID,
			Kind:            steerMsg.kind,
			MachineAuthored: types.InjectionKind(steerMsg.kind).IsMachineToMachine(),
		}})
		return true
	default:
		return false
	}
}
