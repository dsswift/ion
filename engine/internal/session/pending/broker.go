// Package pending manages typed pending-request maps with register/resolve
// semantics. Thread-safe with its own mutex — does not import session.
package pending

import (
	"sync"
)

// ElicitReply carries a client's response to an engine_elicitation_request event.
type ElicitReply struct {
	Response  map[string]interface{}
	Cancelled bool
}

// EarlyStopReply carries a wire-protocol response to an
// engine_early_stop_decision_request event. All fields are optional; an
// empty reply expresses no opinion. The fields mirror
// backend.EarlyStopDecisionResult so the dispatching layer can convert
// without an extra type round-trip.
type EarlyStopReply struct {
	ForceContinue        *bool
	OverrideBudget       int
	OverrideThresholdPct int
	ContinueMessage      string
}

// ToolGateReply carries a client's answer to an engine_tool_gate_request
// event. For a "policy" request, Decision is "allow" or "deny" and Reason is
// the model-facing message a deny carries into the tool result. For a "tool"
// request (a client-declared tool call), Content carries the tool result text
// and IsError marks it as a failure.
type ToolGateReply struct {
	Decision string
	Reason   string
	Content  string
	IsError  bool
}

// Broker manages pending permission, dialog, elicitation, early-stop, and
// tool-gate request maps. Each map type uses a buffered channel so callers can
// block until the response arrives.
type Broker struct {
	mu          sync.RWMutex
	permissions map[string]chan string
	dialogs     map[string]chan interface{}
	elicits     map[string]chan ElicitReply
	earlyStops  map[string]chan EarlyStopReply
	toolGates   map[string]chan ToolGateReply
}

// New creates a ready-to-use Broker.
func New() *Broker {
	return &Broker{
		permissions: make(map[string]chan string),
		dialogs:     make(map[string]chan interface{}),
		elicits:     make(map[string]chan ElicitReply),
		earlyStops:  make(map[string]chan EarlyStopReply),
		toolGates:   make(map[string]chan ToolGateReply),
	}
}

// --- Permissions ---

// RegisterPermission creates a channel for an in-flight permission request.
// Returns the channel the hook server should block on.
func (b *Broker) RegisterPermission(id string) chan string {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan string, 1)
	b.permissions[id] = ch
	return ch
}

// ResolvePermission sends the chosen option ID to the waiting channel.
// Non-blocking: if nobody is listening the send is dropped.
func (b *Broker) ResolvePermission(id string, optionID string) {
	b.mu.RLock()
	ch, ok := b.permissions[id]
	b.mu.RUnlock()
	if !ok {
		return
	}
	select {
	case ch <- optionID:
	default:
	}
}

// UnregisterPermission removes a pending permission entry.
func (b *Broker) UnregisterPermission(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.permissions, id)
}

// --- Dialogs ---

// RegisterDialog creates a channel for an in-flight dialog request.
func (b *Broker) RegisterDialog(id string) chan interface{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan interface{}, 1)
	b.dialogs[id] = ch
	return ch
}

// ResolveDialog sends the value to the waiting dialog channel.
// Non-blocking: if nobody is listening the send is dropped.
func (b *Broker) ResolveDialog(id string, value interface{}) bool {
	b.mu.RLock()
	ch, ok := b.dialogs[id]
	b.mu.RUnlock()
	if !ok {
		return false
	}
	select {
	case ch <- value:
	default:
	}
	return true
}

// UnregisterDialog removes a pending dialog entry.
func (b *Broker) UnregisterDialog(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.dialogs, id)
}

// --- Elicitations ---

// RegisterElicit creates a channel for an in-flight elicitation request.
func (b *Broker) RegisterElicit(id string) chan ElicitReply {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan ElicitReply, 1)
	b.elicits[id] = ch
	return ch
}

// ResolveElicit sends the reply to the waiting elicitation channel.
// Non-blocking: if nobody is listening the send is dropped.
func (b *Broker) ResolveElicit(id string, reply ElicitReply) bool {
	b.mu.RLock()
	ch, ok := b.elicits[id]
	b.mu.RUnlock()
	if !ok {
		return false
	}
	select {
	case ch <- reply:
	default:
	}
	return true
}

// UnregisterElicit removes a pending elicitation entry.
func (b *Broker) UnregisterElicit(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.elicits, id)
}

// --- EarlyStops ---

// RegisterEarlyStop creates a channel for an in-flight early-stop decision
// request. Returns the channel the runloop should block on.
func (b *Broker) RegisterEarlyStop(id string) chan EarlyStopReply {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan EarlyStopReply, 1)
	b.earlyStops[id] = ch
	return ch
}

// ResolveEarlyStop sends the reply to the waiting early-stop channel.
// Non-blocking: if nobody is listening the send is dropped. Returns true
// when a pending entry existed (regardless of whether the send succeeded —
// a timed-out caller may have moved on but the entry has not yet been
// unregistered).
func (b *Broker) ResolveEarlyStop(id string, reply EarlyStopReply) bool {
	b.mu.RLock()
	ch, ok := b.earlyStops[id]
	b.mu.RUnlock()
	if !ok {
		return false
	}
	select {
	case ch <- reply:
	default:
	}
	return true
}

// UnregisterEarlyStop removes a pending early-stop entry.
func (b *Broker) UnregisterEarlyStop(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.earlyStops, id)
}

// --- Tool gates ---

// RegisterToolGate creates a channel for an in-flight tool-gate request.
// Returns the channel the tool loop blocks on.
func (b *Broker) RegisterToolGate(id string) chan ToolGateReply {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan ToolGateReply, 1)
	b.toolGates[id] = ch
	return ch
}

// ResolveToolGate sends the client's decision to the waiting channel.
// Non-blocking: if nobody is listening the send is dropped. Returns true
// when a pending entry existed (a timed-out caller may have moved on but
// the entry has not yet been unregistered).
func (b *Broker) ResolveToolGate(id string, reply ToolGateReply) bool {
	b.mu.RLock()
	ch, ok := b.toolGates[id]
	b.mu.RUnlock()
	if !ok {
		return false
	}
	select {
	case ch <- reply:
	default:
	}
	return true
}

// UnregisterToolGate removes a pending tool-gate entry.
func (b *Broker) UnregisterToolGate(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.toolGates, id)
}
