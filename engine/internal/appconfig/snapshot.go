// Package appconfig resolves authenticated, deferred application
// configuration: values scoped to the verified principal, fetched after that
// principal becomes available rather than at process start, held in memory
// only, and shared by every extension through one snapshot.
package appconfig

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// State is the lifecycle position of the application config snapshot.
type State string

const (
	// StateDisabled means no applicationConfig source is configured. The
	// subsystem is inert and never leaves this state.
	StateDisabled State = "disabled"
	// StateDeferred means no verified principal is available yet, or the
	// reader is not the principal the snapshot was resolved for. Nothing
	// has been fetched for the reader.
	StateDeferred State = "deferred"
	// StateFetching means the first resolution for the current principal
	// is in flight.
	StateFetching State = "fetching"
	// StateReady means Values holds the resolved configuration.
	StateReady State = "ready"
	// StateFailed means resolution was attempted and failed; Error holds
	// the reason. The store retries on the refresh interval.
	StateFailed State = "failed"
)

// Settled reports whether a reader waiting for readiness should stop
// waiting: the values are available, resolution failed, or the subsystem
// is not configured at all.
func (s State) Settled() bool {
	return s == StateReady || s == StateFailed || s == StateDisabled
}

// Snapshot is one complete, immutable view of the application config. Every
// transition produces a new Snapshot; consumers replace their view with it.
type Snapshot struct {
	State State `json:"state"`
	// Revision increases by one on every transition, so a consumer that
	// sees snapshots out of order keeps the highest.
	Revision uint64 `json:"revision"`
	// Subject and Provider identify the principal the snapshot belongs to.
	// Empty while deferred.
	Subject  string `json:"subject,omitempty"`
	Provider string `json:"provider,omitempty"`
	// Values is the resolved configuration object. Present only when ready.
	Values map[string]any `json:"values,omitempty"`
	// Error is the failure reason. Present only when failed.
	Error string `json:"error,omitempty"`
	// FetchedAt is the RFC 3339 time Values were resolved. Present only
	// when ready.
	FetchedAt string `json:"fetchedAt,omitempty"`
}

// For returns the view of s a reader acting as subject may see. A reader
// who is not the principal the snapshot was resolved for sees deferred with
// no values, so one principal's configuration never reaches another. An
// empty subject reads the process view unchanged.
func (s Snapshot) For(subject string) Snapshot {
	if subject == "" || s.Subject == "" || subject == s.Subject {
		return s.clone()
	}
	return Snapshot{State: StateDeferred, Revision: s.Revision}
}

// Lookup returns the value stored under key and whether it exists. A
// snapshot that is not ready never finds a key, so callers check State
// before treating found=false as "the key does not exist".
func (s Snapshot) Lookup(key string) (any, bool) {
	if s.State != StateReady {
		return nil, false
	}
	value, ok := s.Values[key]
	return value, ok
}

// clone deep-copies Values so no reader can mutate another reader's view.
func (s Snapshot) clone() Snapshot {
	out := s
	out.Values = cloneValues(s.Values)
	return out
}

func cloneValues(values map[string]any) map[string]any {
	if values == nil {
		return nil
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "appconfig", "snapshot values clone failed", map[string]any{"error": err.Error()})
		return nil
	}
	var copied map[string]any
	if err := json.Unmarshal(encoded, &copied); err != nil {
		utils.LogWithFields(utils.LevelError, "appconfig", "snapshot values clone failed", map[string]any{"error": err.Error()})
		return nil
	}
	return copied
}
