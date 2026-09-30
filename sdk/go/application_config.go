// application_config.go — authenticated, deferred application config.
//
// The engine resolves configuration scoped to the verified principal after
// that principal signs in, holds it in memory, and shares one snapshot with
// every extension. Each extension sees the common section plus its own
// section, keyed by its enterprise allowlist entry. Secret values stay in the
// engine; an extension sees only their names. Every read carries the
// lifecycle state beside the values, so "still loading" is never confused
// with "the key does not exist".
package ion

import (
	"context"
	"time"
)

// ApplicationConfigState is the lifecycle position of the snapshot.
type ApplicationConfigState string

const (
	// ApplicationConfigDisabled means the engine has no applicationConfig
	// source configured. It never changes.
	ApplicationConfigDisabled ApplicationConfigState = "disabled"
	// ApplicationConfigDeferred means no principal is available yet for
	// this reader.
	ApplicationConfigDeferred ApplicationConfigState = "deferred"
	// ApplicationConfigFetching means the first resolution is in flight.
	ApplicationConfigFetching ApplicationConfigState = "fetching"
	// ApplicationConfigReady means values are available.
	ApplicationConfigReady ApplicationConfigState = "ready"
	// ApplicationConfigRefreshing means a refresh is in flight. The
	// previous values stay available until the refresh replaces them.
	ApplicationConfigRefreshing ApplicationConfigState = "refreshing"
	// ApplicationConfigFailed means resolution failed; Error holds why.
	ApplicationConfigFailed ApplicationConfigState = "failed"
)

// HasValues reports whether a view in this state carries values: ready, or
// refreshing on top of a previous ready view.
func (s ApplicationConfigState) HasValues() bool {
	return s == ApplicationConfigReady || s == ApplicationConfigRefreshing
}

// ApplicationConfigSnapshot is one complete view of the application config.
// It is also the application_config_changed payload.
type ApplicationConfigSnapshot struct {
	State ApplicationConfigState `json:"state"`
	// Revision increases on every transition; keep the highest seen.
	Revision uint64 `json:"revision"`
	// Subject and Provider name the principal the values belong to.
	Subject  string `json:"subject,omitempty"`
	Provider string `json:"provider,omitempty"`
	// Values holds the resolved configuration when State.HasValues().
	Values map[string]any `json:"values,omitempty"`
	// SecretKeys names the secrets the engine holds for this extension.
	// Their values never reach extension code.
	SecretKeys []string `json:"secretKeys,omitempty"`
	// Error is the failure reason when State is failed.
	Error string `json:"error,omitempty"`
	// FetchedAt is the RFC 3339 resolution time when State.HasValues().
	FetchedAt string `json:"fetchedAt,omitempty"`
}

// ApplicationConfigValue is one keyed read.
type ApplicationConfigValue struct {
	State    ApplicationConfigState `json:"state"`
	Revision uint64                 `json:"revision"`
	Error    string                 `json:"error,omitempty"`
	Key      string                 `json:"key"`
	// Found is meaningful only when State.HasValues(): false then means
	// the key is not a readable value.
	Found bool `json:"found"`
	Value any  `json:"value,omitempty"`
	// Secret reports that Key names a secret the engine holds. Its value is
	// never returned.
	Secret bool `json:"secret,omitempty"`
}

// ApplicationConfigAPI is the application config surface, reached via
// [Context.ApplicationConfig].
type ApplicationConfigAPI struct{ ctx *Context }

// ApplicationConfig returns the authenticated application config surface.
func (c *Context) ApplicationConfig() *ApplicationConfigAPI { return &ApplicationConfigAPI{ctx: c} }

// Snapshot returns the current view without waiting.
func (a *ApplicationConfigAPI) Snapshot(ctx context.Context) (ApplicationConfigSnapshot, error) {
	var out ApplicationConfigSnapshot
	if err := a.ctx.sdk.call(ctx, "ext/get_application_config", map[string]any{}, &out); err != nil {
		a.ctx.sdk.logger.Error("application config read failed", map[string]any{"error": err.Error()})
		return ApplicationConfigSnapshot{}, err
	}
	return out, nil
}

// Get reads one key without waiting.
func (a *ApplicationConfigAPI) Get(ctx context.Context, key string) (ApplicationConfigValue, error) {
	var out ApplicationConfigValue
	if err := a.ctx.sdk.call(ctx, "ext/get_application_config", map[string]any{"key": key}, &out); err != nil {
		a.ctx.sdk.logger.Error("application config read failed", map[string]any{"key": key, "error": err.Error()})
		return ApplicationConfigValue{}, err
	}
	return out, nil
}

// Await waits until the view has values or failed, or timeout passes, and
// returns the latest view either way. timedOut reports that the view had
// not settled. Zero timeout uses the engine default.
func (a *ApplicationConfigAPI) Await(ctx context.Context, timeout time.Duration) (snapshot ApplicationConfigSnapshot, timedOut bool, err error) {
	var out struct {
		ApplicationConfigSnapshot
		TimedOut bool `json:"timedOut,omitempty"`
	}
	params := map[string]any{"timeoutMs": float64(timeout.Milliseconds())}
	if err := a.ctx.sdk.call(ctx, "ext/await_application_config", params, &out); err != nil {
		a.ctx.sdk.logger.Error("application config await failed", map[string]any{"error": err.Error()})
		return ApplicationConfigSnapshot{}, false, err
	}
	a.ctx.sdk.logger.Debug("application config await answered", map[string]any{
		"state": string(out.State), "revision": out.Revision, "timed_out": out.TimedOut,
	})
	return out.ApplicationConfigSnapshot, out.TimedOut, nil
}
