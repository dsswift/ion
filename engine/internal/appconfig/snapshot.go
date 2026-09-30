// Package appconfig resolves authenticated, deferred application
// configuration: values scoped to the verified principal, fetched after that
// principal becomes available rather than at process start, held in memory
// only, and shared by every extension through one snapshot.
package appconfig

import (
	"encoding/json"
	"sort"

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
	// StateReady means the resolved configuration is available.
	StateReady State = "ready"
	// StateRefreshing means a refresh is in flight. The previous values
	// stay readable until the refresh replaces them whole.
	StateRefreshing State = "refreshing"
	// StateFailed means resolution was attempted and failed; Error holds
	// the reason. The store retries on the refresh interval.
	StateFailed State = "failed"
)

// HasValues reports whether a snapshot in this state carries resolved
// values: ready, or refreshing on top of a previous ready snapshot.
func (s State) HasValues() bool {
	return s == StateReady || s == StateRefreshing
}

// Settled reports whether a reader waiting for readiness should stop
// waiting: values are available, resolution failed, or the subsystem is not
// configured at all.
func (s State) Settled() bool {
	return s.HasValues() || s == StateFailed || s == StateDisabled
}

// Section is one provider's configuration. Values are plain configuration
// an extension may read. Secrets stay inside the engine: an extension learns
// a secret's name, never its value.
type Section struct {
	Values  map[string]any    `json:"values,omitempty"`
	Secrets map[string]string `json:"secrets,omitempty"`
}

// Document is the configuration the source returns. Common is visible to
// every extension. Extensions holds one section per trusted extension
// identity; an extension sees Common plus its own section and no other.
type Document struct {
	Common     Section            `json:"common"`
	Extensions map[string]Section `json:"extensions,omitempty"`
}

// Snapshot is one complete, immutable process-level state of the
// application config. Every transition produces a new Snapshot; Document is
// never mutated after it is installed. Snapshots never leave the engine:
// readers receive a View.
type Snapshot struct {
	State State
	// Revision increases by one on every transition, so a consumer that
	// sees views out of order keeps the highest.
	Revision uint64
	// Subject and Provider identify the principal the snapshot belongs to.
	// Empty while deferred.
	Subject  string
	Provider string
	// Document is the resolved configuration, including secrets. Present
	// only when State.HasValues().
	Document *Document
	// Error is the failure reason. Present only when failed.
	Error string
	// FetchedAt is the RFC 3339 time Document was resolved.
	FetchedAt string
}

// View is what one extension may see of a snapshot: the common values
// merged with its own section's values, and the names of the secrets held
// for it. It is the wire shape of every read and of the
// application_config_changed payload.
type View struct {
	State    State  `json:"state"`
	Revision uint64 `json:"revision"`
	Subject  string `json:"subject,omitempty"`
	Provider string `json:"provider,omitempty"`
	// Values is present only when State.HasValues().
	Values map[string]any `json:"values,omitempty"`
	// SecretKeys names the secrets the engine holds for this extension.
	// Their values never cross into extension code.
	SecretKeys []string `json:"secretKeys,omitempty"`
	Error      string   `json:"error,omitempty"`
	FetchedAt  string   `json:"fetchedAt,omitempty"`
}

// View returns what the extension trusted as extensionID may see while
// acting as subject. A reader who is not the principal the snapshot was
// resolved for sees deferred with no values, so one principal's
// configuration never reaches another. An empty subject reads the process
// view. An empty extensionID (no enterprise allowlist vouches for the
// extension) sees the common section only.
func (s Snapshot) View(subject, extensionID string) View {
	if subject != "" && s.Subject != "" && subject != s.Subject {
		return View{State: StateDeferred, Revision: s.Revision}
	}
	view := View{
		State: s.State, Revision: s.Revision, Subject: s.Subject, Provider: s.Provider,
		Error: s.Error, FetchedAt: s.FetchedAt,
	}
	if !s.State.HasValues() || s.Document == nil {
		return view
	}
	values := map[string]any{}
	secrets := map[string]struct{}{}
	overlay := func(section Section) {
		for key, value := range section.Values {
			values[key] = value
			delete(secrets, key)
		}
		for key := range section.Secrets {
			secrets[key] = struct{}{}
			delete(values, key)
		}
	}
	overlay(s.Document.Common)
	if extensionID != "" {
		if own, ok := s.Document.Extensions[extensionID]; ok {
			overlay(own)
		}
	}
	view.Values = cloneValues(values)
	for key := range secrets {
		view.SecretKeys = append(view.SecretKeys, key)
	}
	sort.Strings(view.SecretKeys)
	return view
}

// Lookup returns the value stored under key. found is false whenever the
// view carries no values, so callers check State before treating
// found=false as "the key does not exist". secret reports that the key
// names a secret the engine holds but never returns.
func (v View) Lookup(key string) (value any, found, secret bool) {
	if !v.State.HasValues() {
		return nil, false, false
	}
	if value, ok := v.Values[key]; ok {
		return value, true, false
	}
	idx := sort.SearchStrings(v.SecretKeys, key)
	return nil, false, idx < len(v.SecretKeys) && v.SecretKeys[idx] == key
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
