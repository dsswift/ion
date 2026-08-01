package types

// InjectionKind classifies an engine-side injected user turn.
//
// ── What the engine owns, and what it does not ──────────────────────────────
//
// The engine owns the CLASSIFICATION: it knows, at the moment of injection,
// whether a turn was authored by a human at a client or synthesized by an
// engine-side actor (a dispatch callback, a scheduler wake-up, a slash-command
// expansion). It publishes that fact and stops there.
//
// The engine does NOT own the SUPPRESSION POLICY. Whether a machine-authored
// turn is hidden, dimmed, collapsed, or rendered verbatim is a consumer's
// opinion, and consumers legitimately differ: an interactive client hides the
// noise, a headless pipeline that reconstructs the exact LLM context wants
// every turn, and an audit tool wants them visually distinguished rather than
// dropped. Baking one of those into the engine would force every consumer
// through a single UI-shaped interpretation. See ADR-017 and the root
// AGENTS.md § "Opinionless mechanics, extensible opinions".
//
// ── Why this type exists at all ─────────────────────────────────────────────
//
// The kind used to be a bare string, defined nowhere and re-decided everywhere:
// two unrelated consts, a literal repeated across the engine, and five
// hand-copied suppression lists across two clients. Every new kind required
// editing all five by hand, nothing failed when one was missed, and they had
// already drifted apart. Enumerating the set here — with an exhaustive
// IsMachineToMachine — means a new kind is classified ONCE, at its definition,
// and every consumer inherits the correct behaviour through the derived
// MachineAuthored flag on the wire.
type InjectionKind string

const (
	// InjectionKindNone is the zero value: a genuine user-authored turn, or an
	// extension-initiated turn the injector chose not to classify. Never
	// machine-authored — an unclassified injection is treated as a real turn,
	// because silently hiding content the engine could not identify is worse
	// than showing a turn a consumer did not expect.
	InjectionKindNone InjectionKind = ""

	// InjectionKindAgentCompletion is a machine-to-machine dispatch callback:
	// a completed child agent's result routed back to the parent that
	// dispatched it. Not a turn any user authored.
	InjectionKindAgentCompletion InjectionKind = "agent_completion"

	// InjectionKindSlashCommand is the expanded body of a slash command whose
	// DISPLAY turn is persisted separately as the raw invocation (see
	// conversation.AddUserMessageWithInvocation). The expansion is redundant
	// with the invocation the user actually typed: both describe one user
	// action, and rendering both puts the whole command template on screen as
	// a second user message.
	//
	// Machine-authored in the sense that matters here — the user did not type
	// this text — even though a user action ultimately caused it.
	InjectionKindSlashCommand InjectionKind = "slash_command"

	// InjectionKindBackgroundTaskCompletion is a finished background bash
	// command's result, routed back to wake a parked session (ADR-023). The
	// engine is reporting an exit code and an output tail to the model, not
	// relaying something a user said.
	InjectionKindBackgroundTaskCompletion InjectionKind = "background_task_completion"

	// InjectionKindCheckIn is a scheduled heartbeat delivered to a session that
	// went idle with work still running — a harness asking its own orchestrator
	// to look at outstanding dispatches. Fires with no user present, by
	// definition: the schedule is armed precisely BECAUSE the session went
	// idle.
	InjectionKindCheckIn InjectionKind = "checkin"

	// InjectionKindRevive wakes an idle session for a reason that is not a
	// completion payload and not a periodic check-in — a harness re-entering
	// its own loop after an external signal. Distinct from AgentCompletion so a
	// consumer can tell "here is a child's result" from "keep going".
	InjectionKindRevive InjectionKind = "revive"

	// InjectionKindSteer is a steer message injected mid-turn onto a live run.
	//
	// NOT machine-authored by default: the overwhelmingly common steer is a
	// human typing into a running turn, which is as user-authored as a turn
	// gets. The kind exists so the persisted row records HOW the turn arrived
	// (steered into a live run rather than starting one), not to hide it. A
	// machine-originated steer passes its own kind — checkin, revive, or
	// agent_completion — and is classified by that instead.
	InjectionKindSteer InjectionKind = "steer"
)

// IsMachineToMachine reports whether a turn of this kind was authored by an
// engine-side actor rather than by a user.
//
// This is the single classification point. Consumers read the derived boolean
// off the wire instead of matching kind strings, so adding a kind above (and
// classifying it here) reaches every client with no client-side edit — which
// is the entire reason this type exists.
//
// The switch is deliberately EXHAUSTIVE over the const set and is pinned by
// TestIsMachineToMachineIsExhaustive: adding a kind without classifying it
// fails that test rather than silently defaulting to "user authored".
func (k InjectionKind) IsMachineToMachine() bool {
	switch k {
	case InjectionKindAgentCompletion,
		InjectionKindSlashCommand,
		InjectionKindBackgroundTaskCompletion,
		InjectionKindCheckIn,
		InjectionKindRevive:
		return true
	case InjectionKindNone, InjectionKindSteer:
		return false
	default:
		// A consumer-defined kind the engine does not know. Treated as
		// user-authored on purpose: the engine cannot vouch for a
		// classification it did not make, and defaulting to "hide it" would
		// let an unrecognized string silently disappear content.
		return false
	}
}

// String renders the kind for logs and for the wire.
func (k InjectionKind) String() string { return string(k) }

// AllInjectionKinds is every kind the engine defines, including the empty
// zero value. Exported so the exhaustiveness test and any consumer-facing
// enumeration read from one list rather than restating it.
var AllInjectionKinds = []InjectionKind{
	InjectionKindNone,
	InjectionKindAgentCompletion,
	InjectionKindSlashCommand,
	InjectionKindBackgroundTaskCompletion,
	InjectionKindCheckIn,
	InjectionKindRevive,
	InjectionKindSteer,
}
