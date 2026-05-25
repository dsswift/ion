// Package asyncreg owns the in-memory registry of asynchronously-triggered
// extension handlers (webhooks and scheduled jobs) that the engine fires on
// behalf of an extension host.
//
// The registry is the single source of truth for "what async triggers does
// this host currently expose?" Both the init handshake and the dynamic
// register/deregister RPCs route through it; both the HTTP dispatcher (for
// webhooks) and the scheduler tick loop (for schedules) read from it.
//
// Per the D-010 / D-011 design:
//   - Declarations are extension-owned. The registry is in-memory only and
//     does NOT persist across engine restarts; declarations re-register
//     from the next subprocess `init`.
//   - Lifecycle hooks (webhook_registered / webhook_deregistered /
//     schedule_registered / schedule_deregistered) fire on every change.
//     The `*_registered` variants may veto (handler returns `{block,
//     reason}`); deregister hooks are informational only.
//   - Per-host scope: extension A cannot mutate extension B's registrations.
//     Cross-host policy hooks would be a future enterprise extension.
//   - A per-host cap (default 256 per kind) prevents runaway registration
//     storms; hitting the cap returns a structured error.
//
// The registry is intentionally engine-agnostic about the wire RPC name and
// the HTTP dispatch shape. It owns the data structures, the veto pipeline,
// and the change-notification fan-out. Callers (host_rpc, session wiring,
// webhooks server, scheduler) project policy onto these primitives.
package asyncreg

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Kind discriminates the kind of async trigger a declaration represents.
// New kinds are added by introducing a new constant and threading it
// through Registry callers; the registry itself is kind-agnostic except
// for separating declarations into independent slots for List/Subscribe.
type Kind string

const (
	// KindWebhook is the kind for HTTP webhook routes.
	KindWebhook Kind = "webhook"
	// KindSchedule is the kind for scheduled jobs (daily / weekly / interval).
	KindSchedule Kind = "schedule"
)

// Origin labels how a registration arrived at the registry. Used in
// lifecycle-event payloads so consumers can distinguish init-time bulk
// declarations from runtime add/remove operations.
type Origin string

const (
	// OriginInit means the declaration came in via the extension's `init`
	// handshake response. Veto at this stage fails host load.
	OriginInit Origin = "init"
	// OriginRuntime means the declaration came in via a dynamic
	// `ext/register_*` RPC after init. Veto is surfaced to the caller.
	OriginRuntime Origin = "runtime"
)

// Declaration is the minimal shape every async trigger declaration must
// satisfy. Each concrete declaration type (webhook route, schedule job)
// implements this so the registry can store, look up, and dispatch
// without compile-time knowledge of every kind.
type Declaration interface {
	// ID returns the unique identifier for this declaration within its
	// kind (webhook: path; schedule: job id). Empty IDs are rejected.
	ID() string
}

// ChangeOp describes the kind of change event a subscriber sees.
type ChangeOp string

const (
	// ChangeAdded is emitted after a successful Register (post-veto).
	ChangeAdded ChangeOp = "added"
	// ChangeRemoved is emitted after a successful Deregister.
	ChangeRemoved ChangeOp = "removed"
)

// ChangeEvent is the payload published to Subscribe channels when a
// registration is added or removed. Subscribers use it to refresh their
// view of the active declarations (HTTP route table, scheduler job list).
type ChangeEvent struct {
	Kind   Kind
	Op     ChangeOp
	ID     string
	Origin Origin
}

// VetoFunc is invoked by Register before a declaration is committed. The
// caller (host_rpc / init wiring) wires this to the SDK's
// FireWebhookRegistered / FireScheduleRegistered hook. Returning a
// non-nil error vetoes the registration; the error message is surfaced
// to the caller and to the lifecycle observability event.
//
// The hook fires *outside* the registry's mutex so reentrant
// registration calls (a hook handler that registers another route) do
// not deadlock.
type VetoFunc func(kind Kind, decl Declaration, origin Origin) error

// NotifyFunc is invoked by Deregister (after the entry is removed from
// the registry, outside the mutex) so the caller can fire the
// *_deregistered hook for observability. Deregistration cannot be
// vetoed; the return value is ignored.
type NotifyFunc func(kind Kind, decl Declaration, origin Origin)

// DefaultCap is the per-host, per-kind ceiling on the number of
// registrations the registry accepts before returning ErrCapExceeded.
// Configurable via SetCap. Chosen to be comfortably above any plausible
// human-curated set while still bounded so a buggy extension calling
// register in a hot loop is caught quickly.
const DefaultCap = 256

// ErrCapExceeded is returned by Register when the per-kind cap is hit.
// Callers should surface this as an explicit RPC error and emit an
// engine_async_fire_dropped event with reason="cap_exceeded".
var ErrCapExceeded = fmt.Errorf("asyncreg: registration cap exceeded")

// ErrDuplicate is returned by Register when a declaration with the same
// (kind, id) already exists. Callers should surface this as a structured
// RPC error so the extension can react. Update semantics are
// deregister-then-register; the registry does not silently overwrite.
var ErrDuplicate = fmt.Errorf("asyncreg: duplicate id within kind")

// ErrEmptyID is returned by Register when a declaration's ID() returns
// the empty string. Empty IDs cannot be looked up or deregistered, so we
// reject them at the entry door rather than store useless state.
var ErrEmptyID = fmt.Errorf("asyncreg: declaration ID is empty")

// Registry holds the active declarations for a single extension host.
// Multiple hosts inside the same session each carry their own Registry —
// scoping per-host means extension A cannot mutate extension B's
// declarations (decision 8 / 9 of the design).
//
// All exported methods are safe for concurrent use.
type Registry struct {
	mu sync.RWMutex

	// entries[kind][id] = entry (declaration + origin metadata).
	// Origins are stored so lifecycle events can report whether a given
	// registration came from init or from a runtime RPC.
	entries map[Kind]map[string]entry

	// cap is the per-kind ceiling. Zero means use DefaultCap.
	cap int

	// subs[kind] is a fan-out of change-event channels. Subscribers
	// register via Subscribe and read until they disconnect (returned
	// cancel func closes the channel and removes it from the fan-out).
	subs map[Kind][]chan ChangeEvent
}

type entry struct {
	decl   Declaration
	origin Origin
}

// New returns a fresh Registry. cap=0 selects DefaultCap.
func New(cap int) *Registry {
	if cap <= 0 {
		cap = DefaultCap
	}
	return &Registry{
		entries: make(map[Kind]map[string]entry),
		cap:     cap,
		subs:    make(map[Kind][]chan ChangeEvent),
	}
}

// SetCap updates the per-kind ceiling. Existing entries are not affected.
// Useful for tests; production code uses New(cap) at construction time.
func (r *Registry) SetCap(cap int) {
	if cap <= 0 {
		cap = DefaultCap
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cap = cap
}

// Register adds a declaration to the registry. The provided veto func
// (typically a closure that fires the *_registered SDK hook) runs
// *outside* the registry mutex so a veto handler can recursively call
// Register/Deregister without deadlocking.
//
// Behavior:
//   - Empty declaration ID → ErrEmptyID.
//   - Duplicate (kind, id) → ErrDuplicate.
//   - Cap reached → ErrCapExceeded.
//   - Veto returns non-nil err → that err (registration is rolled back).
//   - Success → declaration stored, change-event published, nil error.
//
// Logging: every outcome logs at Debug with (kind, id, origin, result)
// per the engine logging policy. Callers should emit the corresponding
// engine_*_registered observability event after Register returns nil.
func (r *Registry) Register(kind Kind, decl Declaration, origin Origin, veto VetoFunc) error {
	if decl == nil {
		utils.Debug("asyncreg", fmt.Sprintf("Register: kind=%s nil declaration rejected", kind))
		return fmt.Errorf("asyncreg: declaration is nil")
	}
	id := decl.ID()
	if id == "" {
		utils.Debug("asyncreg", fmt.Sprintf("Register: kind=%s empty id rejected origin=%s", kind, origin))
		return ErrEmptyID
	}

	// Phase 1: check duplicates / cap under the mutex, but don't commit yet.
	r.mu.RLock()
	bucket := r.entries[kind]
	if _, exists := bucket[id]; exists {
		r.mu.RUnlock()
		utils.Debug("asyncreg", fmt.Sprintf("Register: kind=%s id=%q duplicate origin=%s", kind, id, origin))
		return ErrDuplicate
	}
	if len(bucket) >= r.cap {
		size := len(bucket)
		cap := r.cap
		r.mu.RUnlock()
		utils.Debug("asyncreg", fmt.Sprintf("Register: kind=%s id=%q cap_exceeded size=%d cap=%d origin=%s", kind, id, size, cap, origin))
		return ErrCapExceeded
	}
	r.mu.RUnlock()

	// Phase 2: run the veto pipeline outside the mutex. Reentrant
	// register/deregister calls from inside the veto handler are safe.
	if veto != nil {
		if err := veto(kind, decl, origin); err != nil {
			utils.Log("asyncreg", fmt.Sprintf("Register: kind=%s id=%q vetoed origin=%s reason=%v", kind, id, origin, err))
			return err
		}
	}

	// Phase 3: re-check + commit under the mutex. A racing Register with
	// the same id between Phase 1 and here would otherwise sneak through.
	r.mu.Lock()
	if r.entries[kind] == nil {
		r.entries[kind] = make(map[string]entry)
	}
	if _, exists := r.entries[kind][id]; exists {
		r.mu.Unlock()
		utils.Debug("asyncreg", fmt.Sprintf("Register: kind=%s id=%q raced-duplicate origin=%s", kind, id, origin))
		return ErrDuplicate
	}
	if len(r.entries[kind]) >= r.cap {
		size := len(r.entries[kind])
		cap := r.cap
		r.mu.Unlock()
		utils.Debug("asyncreg", fmt.Sprintf("Register: kind=%s id=%q raced-cap size=%d cap=%d origin=%s", kind, id, size, cap, origin))
		return ErrCapExceeded
	}
	r.entries[kind][id] = entry{decl: decl, origin: origin}
	// Snapshot subscribers before unlocking so a slow subscriber doesn't
	// hold the registry write-lock for the duration of its channel send.
	channels := append([]chan ChangeEvent(nil), r.subs[kind]...)
	r.mu.Unlock()

	utils.Log("asyncreg", fmt.Sprintf("Register: kind=%s id=%q origin=%s committed", kind, id, origin))
	publishChange(channels, ChangeEvent{Kind: kind, Op: ChangeAdded, ID: id, Origin: origin})
	return nil
}

// Deregister removes a declaration from the registry. The notify func
// (typically a closure that fires the *_deregistered SDK hook for
// observability) runs *after* the entry has been removed, outside the
// mutex. Deregistration cannot be vetoed.
//
// Returns true if the entry was present and removed, false if no such
// id existed (a no-op the caller can surface as a 200/{ok:true} or
// silently — the design choice belongs to the wire layer).
func (r *Registry) Deregister(kind Kind, id string, notify NotifyFunc) bool {
	if id == "" {
		utils.Debug("asyncreg", fmt.Sprintf("Deregister: kind=%s empty id", kind))
		return false
	}
	r.mu.Lock()
	bucket := r.entries[kind]
	e, exists := bucket[id]
	if !exists {
		r.mu.Unlock()
		utils.Debug("asyncreg", fmt.Sprintf("Deregister: kind=%s id=%q not_found", kind, id))
		return false
	}
	delete(bucket, id)
	channels := append([]chan ChangeEvent(nil), r.subs[kind]...)
	r.mu.Unlock()

	utils.Log("asyncreg", fmt.Sprintf("Deregister: kind=%s id=%q removed origin=%s", kind, id, e.origin))
	if notify != nil {
		notify(kind, e.decl, e.origin)
	}
	publishChange(channels, ChangeEvent{Kind: kind, Op: ChangeRemoved, ID: id, Origin: e.origin})
	return true
}

// publishChange fans a change event out to every subscriber channel.
// Sends are non-blocking; a subscriber that falls behind misses the
// event (a structured drop is preferable to stalling the whole
// registry). Tests rely on bounded channels so the non-blocking send
// always succeeds in practice.
func publishChange(channels []chan ChangeEvent, ev ChangeEvent) {
	for _, ch := range channels {
		select {
		case ch <- ev:
		default:
			utils.Debug("asyncreg", fmt.Sprintf("publishChange: subscriber dropped event kind=%s op=%s id=%q", ev.Kind, ev.Op, ev.ID))
		}
	}
}

// List returns every declaration currently registered under the given
// kind. The returned slice is a fresh snapshot; mutating it does not
// affect the registry. Ordering is unspecified.
func (r *Registry) List(kind Kind) []Declaration {
	r.mu.RLock()
	defer r.mu.RUnlock()
	bucket := r.entries[kind]
	out := make([]Declaration, 0, len(bucket))
	for _, e := range bucket {
		out = append(out, e.decl)
	}
	return out
}

// ByID returns the declaration with the given id under the given kind.
// The second return value is false when no such id exists.
func (r *Registry) ByID(kind Kind, id string) (Declaration, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[kind][id]
	if !ok {
		return nil, false
	}
	return e.decl, true
}

// Count returns the number of declarations currently registered under
// the given kind. Useful for cap enforcement diagnostics and tests.
func (r *Registry) Count(kind Kind) int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.entries[kind])
}

// Subscribe returns a channel that receives a ChangeEvent on every
// successful Register / Deregister under the given kind, plus a cancel
// func the caller invokes when it is done (closes the channel and
// removes it from the fan-out). Channel buffer is `buffer`; slow
// subscribers drop events rather than stall the registry.
//
// New subscribers do NOT receive a snapshot of currently-registered
// declarations — callers that need one should call List first, then
// subscribe (and dedup any events that arrive in the window between).
// This matches the established snapshot-vs-incremental boundary: the
// scheduler / dispatcher reads List on startup, then consumes
// incremental Subscribe events thereafter.
func (r *Registry) Subscribe(kind Kind, buffer int) (<-chan ChangeEvent, func()) {
	if buffer <= 0 {
		buffer = 16
	}
	ch := make(chan ChangeEvent, buffer)
	r.mu.Lock()
	r.subs[kind] = append(r.subs[kind], ch)
	r.mu.Unlock()
	utils.Debug("asyncreg", fmt.Sprintf("Subscribe: kind=%s buffer=%d", kind, buffer))

	cancel := func() {
		r.mu.Lock()
		subs := r.subs[kind]
		for i, c := range subs {
			if c == ch {
				r.subs[kind] = append(subs[:i], subs[i+1:]...)
				break
			}
		}
		r.mu.Unlock()
		close(ch)
		utils.Debug("asyncreg", fmt.Sprintf("Subscribe: cancel kind=%s", kind))
	}
	return ch, cancel
}

// Origin returns the origin under which the given (kind, id) was
// registered. Used by host_rpc when answering "where did this come
// from?" queries (so far only the lifecycle events use it). Returns
// ("", false) when no such id exists.
func (r *Registry) Origin(kind Kind, id string) (Origin, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[kind][id]
	if !ok {
		return "", false
	}
	return e.origin, true
}

// Reset removes every entry of the given kind and emits a
// ChangeRemoved event for each one through any subscribed channels.
// Used by the host on subprocess respawn: the prior process's
// declarations are gone with it, but the in-memory registry survives
// the respawn (it lives on Host, not on the subprocess). Reset wipes
// the slate so the new subprocess's init payload can re-register
// without colliding with stale entries.
//
// The notify callback fires once per removed entry (informational —
// matches the Deregister contract). Passing nil skips notifications.
func (r *Registry) Reset(kind Kind, notify NotifyFunc) int {
	r.mu.Lock()
	bucket := r.entries[kind]
	type drop struct {
		decl   Declaration
		origin Origin
	}
	dropped := make([]drop, 0, len(bucket))
	for _, e := range bucket {
		dropped = append(dropped, drop(e))
	}
	r.entries[kind] = make(map[string]entry)
	channels := append([]chan ChangeEvent(nil), r.subs[kind]...)
	r.mu.Unlock()

	for _, d := range dropped {
		if notify != nil {
			notify(kind, d.decl, d.origin)
		}
		publishChange(channels, ChangeEvent{
			Kind:   kind,
			Op:     ChangeRemoved,
			ID:     d.decl.ID(),
			Origin: d.origin,
		})
	}
	if len(dropped) > 0 {
		utils.Log("asyncreg", fmt.Sprintf("Reset: kind=%s removed=%d", kind, len(dropped)))
	}
	return len(dropped)
}
