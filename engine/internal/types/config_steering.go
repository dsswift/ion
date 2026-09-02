package types

// SteeringConfig configures how a steer message reaches a run that is already
// in flight.
//
// Steering is the mechanism by which a new instruction — from an operator
// typing into a running turn, or from a harness bubbling a completion into it —
// is applied to work already underway. The engine owns the mechanism (buffer,
// classify, inject, confirm) and ships one generic default; the questions that
// are genuinely opinions (how aggressively to interrupt, how much to buffer)
// are config, per the opinionless-mechanics rule.
type SteeringConfig struct {
	// InterruptStream controls whether a steer that arrives while the model is
	// streaming assistant text ends that provider call early so the steer is
	// applied on the very next turn.
	//
	// When nil the built-in default (true) wins.
	//
	// The problem it solves: a steer can only be injected at a turn boundary,
	// because a provider request in flight cannot have a message added to it.
	// So without interruption the steer waits for the model to finish
	// composing — and a long final summary or a slow stream turns "change
	// course now" into "change course in a minute", during which the agent is
	// still producing output for the instruction the operator just replaced.
	//
	// When on, the partial assistant text produced so far is KEPT and
	// persisted, exactly as an interrupted stream is elsewhere in the run
	// loop, and the steer lands on the next turn. Nothing the model said is
	// discarded — it is committed early, and the model sees both its own
	// partial output and the new instruction on its next turn.
	//
	// Turn it off when the priority is finishing each provider call as issued
	// (the model always completes its sentence) and a steer waiting for the
	// stream to end is acceptable.
	//
	// This never applies during tool execution: the provider protocol requires
	// every tool_use block to be answered by a tool_result, so a tool call in
	// flight must complete. The post-tool-results drain checkpoint is the
	// earliest legal injection point there, and it already exists.
	InterruptStream *bool `json:"interruptStream,omitempty"`

	// BufferSize is the per-run steer channel capacity — how many steers may
	// be outstanding before the engine reports channel_full and refuses one.
	// Zero means "use default" (32).
	//
	// The buffer exists because a steer is accepted asynchronously and drained
	// at a checkpoint, so a burst can arrive faster than the run reaches one.
	// The default is deliberately generous: a rejection is the one steer
	// outcome with no recovery path inside the engine — the caller must decide
	// what to do with an instruction the engine would not take — and a queued
	// message costs a pointer and a string, whereas a dropped one costs a
	// wrong-direction turn. A caller that genuinely wants back-pressure at a
	// low watermark can set this small.
	BufferSize int `json:"bufferSize,omitempty"`
}

// SteeringDefaults returns the built-in steering configuration.
//
// Interruption defaults to ON. Steering exists to change what an agent is
// doing, and an instruction that applies only after the current stream
// finishes is not steering the current turn — it is steering the next one. The
// engine keeps the partial output either way, so the default costs the
// operator nothing beyond a shorter assistant message, while the alternative
// costs them a turn of work aimed at a superseded instruction.
func SteeringDefaults() SteeringConfig {
	t := true
	return SteeringConfig{
		InterruptStream: &t,
		BufferSize:      defaultSteerBufferSize,
	}
}

// defaultSteerBufferSize is the compiled default steer channel capacity.
const defaultSteerBufferSize = 32

// SteerInterruptStreamEnabled resolves SteeringConfig.InterruptStream with the
// default-ON pointer-bool semantics: nil config, nil pointer, or an explicit
// value. Mirrors thinkingPersistEnabled's shape so every default-ON engine
// toggle resolves the same way.
func SteerInterruptStreamEnabled(cfg *SteeringConfig) bool {
	if cfg == nil || cfg.InterruptStream == nil {
		return true
	}
	return *cfg.InterruptStream
}

// SteerBufferSize resolves the per-run steer channel capacity, falling back to
// the compiled default when the block is absent or the value is unset. A
// negative value is treated as unset rather than as a request for an
// unbuffered channel: an unbuffered steer channel would make every steer
// arriving between checkpoints a hard rejection, which is the failure this
// buffer exists to prevent.
func SteerBufferSize(cfg *SteeringConfig) int {
	if cfg == nil || cfg.BufferSize <= 0 {
		return defaultSteerBufferSize
	}
	return cfg.BufferSize
}
