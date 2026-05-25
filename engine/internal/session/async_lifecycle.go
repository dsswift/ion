// Async-trigger lifecycle wiring on the session Manager.
//
// This file connects the asyncreg.Registry, webhooks.Server, and
// scheduling.Scheduler subsystems into the session lifecycle:
//
//   1. ensureAsyncSubsystems creates the Server and Scheduler lazily
//      on first use. They are Manager-level singletons (one server,
//      one scheduler shared across every session) so the engine never
//      tries to bind two listeners on the same port.
//   2. wireHostAsync registers a single extension host's async hooks:
//      SetOnLifecycleHook (so registry vetoes fire the SDK hook chain
//      with the right session context), SetSessionKey (for fire-time
//      session lookup), and AddHost on both server and scheduler.
//   3. commitHostInitAsyncDecls walks the host's queued init-time
//      declarations through the registry (firing webhook_registered /
//      schedule_registered hooks). Run after wireHostAsync so vetoes
//      can fire.
//   4. unwireHostAsync removes a host from both subsystems at
//      teardown.
//
// The Server and Scheduler themselves know nothing about Manager —
// the manager wires them with closures that resolve sessions through
// sessionAccessor / extcontext.NewExtContext, matching the existing
// pattern for ExtensionGroup wiring.

package session

import (
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/scheduling"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/webhooks"
)

// ensureAsyncSubsystems creates the Manager-level webhook server and
// scheduler if they don't exist yet. Idempotent. Called lazily by
// wireHostAsync so an engine with no async-using extensions never
// pays the listener startup cost.
//
// Returns the server and scheduler so the caller can register hosts
// without re-fetching. Server.Start and Scheduler.Start are deferred
// to ensureAsyncStartedLocked once we know at least one host has a
// declaration of the corresponding kind.
func (m *Manager) ensureAsyncSubsystems() (*webhooks.Server, *scheduling.Scheduler) {
	m.asyncMu.Lock()
	defer m.asyncMu.Unlock()
	if m.webhookServer == nil {
		cfg := webhookConfigFrom(m.config)
		m.webhookServer = webhooks.New(cfg)
		resolver := m.buildAsyncContextResolver()
		m.webhookServer.SetSessionResolver(webhooks.SessionResolver(resolver))
		m.webhookServer.SetEmit(m.buildAsyncEventEmitter())
		utils.Log("session", fmt.Sprintf("ensureAsyncSubsystems: webhook server constructed (port=%d bind=%s)", cfg.Port, cfg.BindInterface))
	}
	if m.scheduler == nil {
		cfg := scheduleConfigFrom(m.config)
		m.scheduler = scheduling.New(cfg)
		resolver := m.buildAsyncContextResolver()
		m.scheduler.SetSessionResolver(scheduling.SessionResolver(resolver))
		m.scheduler.SetEmit(m.buildAsyncEventEmitter())
		utils.Log("session", fmt.Sprintf("ensureAsyncSubsystems: scheduler constructed (default-tz=%s)", cfg.DefaultTz))
	}
	return m.webhookServer, m.scheduler
}

// buildAsyncContextResolver returns a closure that, given a host,
// returns a fresh extension.Context for the session the host is
// bound to. The webhook server and scheduler both call this at fire
// time. The same function shape works for both subsystems but the
// nominal types differ — callers wrap as needed.
func (m *Manager) buildAsyncContextResolver() func(*extension.Host) (*extension.Context, error) {
	return func(host *extension.Host) (*extension.Context, error) {
		key := host.SessionKey()
		if key == "" {
			return nil, fmt.Errorf("host %s has no session key", host.Name())
		}
		m.mu.RLock()
		s, ok := m.sessions[key]
		m.mu.RUnlock()
		if !ok {
			return nil, fmt.Errorf("session %q not found for host %s", key, host.Name())
		}
		ctx := m.newExtContext(s, key)
		return ctx, nil
	}
}

// buildAsyncEventEmitter returns a closure that publishes a server /
// scheduler event onto the right session's emit channel. We rely on
// the EngineEvent's AsyncKind/AsyncID for routing — since the server
// and scheduler are Manager-level singletons we don't know which
// session to emit to without that context. As a pragmatic policy
// during this MVP: emit to every active session that owns a host
// with the matching ID. Until cross-session route conflicts become
// real, this is precise enough.
//
// Future iteration: thread the session key through the FireAsync
// envelope so the emitter can fan to exactly the right session.
func (m *Manager) buildAsyncEventEmitter() func(types.EngineEvent) {
	return func(ev types.EngineEvent) {
		m.mu.RLock()
		// Snapshot sessions and their host lists under the read lock.
		keys := make([]string, 0, len(m.sessions))
		for k := range m.sessions {
			keys = append(keys, k)
		}
		m.mu.RUnlock()
		// For lifecycle and per-fire events, route by AsyncID lookup
		// against each session's extension group. Falls back to
		// emitting to every session for events without an AsyncID
		// (engine_async_fire_dropped from a no-resolver path).
		if ev.AsyncID == "" {
			for _, k := range keys {
				m.emit(k, ev)
			}
			return
		}
		for _, k := range keys {
			if m.sessionOwnsAsyncID(k, ev.AsyncKind, ev.AsyncID) {
				m.emit(k, ev)
				return
			}
		}
		// No session owns this id — emit to the first session as a
		// fallback so the event isn't silently dropped.
		if len(keys) > 0 {
			m.emit(keys[0], ev)
		}
	}
}

// sessionOwnsAsyncID returns true when any host on the given session's
// extension group has a registry entry under (kind, id). Used by the
// event router.
func (m *Manager) sessionOwnsAsyncID(key, kind, id string) bool {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok || s == nil || s.extGroup == nil {
		return false
	}
	for _, h := range s.extGroup.Hosts() {
		if _, found := h.AsyncRegistry().ByID(asyncreg.Kind(kind), id); found {
			return true
		}
	}
	return false
}

// wireHostAsync installs the per-host plumbing: lifecycle-hook
// callback (so the SDK's FireWebhookRegistered etc. wrappers fire when
// the registry vetoes), the host's session key (so fire-time session
// lookup works), and registration on the Manager's server/scheduler.
//
// Called by loadAndWireExtensions for each successfully-loaded host.
// The caller invokes commitHostInitAsyncDecls afterwards to flush any
// init-time declarations through the now-wired veto pipeline.
func (m *Manager) wireHostAsync(key string, host *extension.Host) {
	host.SetSessionKey(key)
	host.SetOnLifecycleHook(func(event string, info extension.AsyncRegistrationInfo) error {
		// Build a fresh context so the hook handler sees the bound
		// session even though the registry doesn't know about ctx.
		m.mu.RLock()
		s, ok := m.sessions[key]
		m.mu.RUnlock()
		if !ok || s == nil {
			// No session yet (init handshake before session is fully
			// wired). Fire with a minimal stub ctx — callHook requires
			// non-nil ctx because it populates `_ctx` on the wire
			// payload; an empty Context with just SessionKey set
			// satisfies that.
			stub := &extension.Context{SessionKey: key}
			return m.fireLifecycleHookSDK(event, stub, info, host)
		}
		ctx := m.newExtContext(s, key)
		return m.fireLifecycleHookSDK(event, ctx, info, host)
	})

	server, scheduler := m.ensureAsyncSubsystems()
	server.AddHost(host)
	scheduler.AddHost(host)
	utils.Debug("session", fmt.Sprintf("wireHostAsync: ext=%s key=%s wired", host.Name(), key))
}

// fireLifecycleHookSDK dispatches the named lifecycle hook through the
// host's SDK and returns any veto. Centralises the event-to-method
// mapping so wireHostAsync stays focused.
func (m *Manager) fireLifecycleHookSDK(event string, ctx *extension.Context, info extension.AsyncRegistrationInfo, host *extension.Host) error {
	sdk := host.SDK()
	switch event {
	case extension.HookWebhookRegistered:
		return sdk.FireWebhookRegistered(ctx, info)
	case extension.HookWebhookDeregistered:
		sdk.FireWebhookDeregistered(ctx, info)
		return nil
	case extension.HookScheduleRegistered:
		return sdk.FireScheduleRegistered(ctx, info)
	case extension.HookScheduleDeregistered:
		sdk.FireScheduleDeregistered(ctx, info)
		return nil
	default:
		utils.Warn("session", fmt.Sprintf("fireLifecycleHookSDK: unknown event %q", event))
		return nil
	}
}

// commitHostInitAsyncDecls flushes the host's queued init-time
// declarations through the registry now that the lifecycle hooks
// are wired. Init-time vetoes log an engine_error per failure but
// do not abort the host load.
func (m *Manager) commitHostInitAsyncDecls(key string, host *extension.Host) {
	errs := host.CommitPendingAsyncDecls()
	for _, err := range errs {
		m.emit(key, types.EngineEvent{
			Type:         "engine_error",
			EventMessage: fmt.Sprintf("async declaration rejected: %v", err),
			ErrorCode:    "async_init_rejected",
		})
	}
	// After commit, check whether the host actually has any webhook /
	// schedule entries and start the corresponding subsystem if so.
	hooksCount := host.AsyncRegistry().Count(asyncreg.KindWebhook)
	schedCount := host.AsyncRegistry().Count(asyncreg.KindSchedule)
	if hooksCount > 0 {
		m.startWebhookServerIfNeeded()
	}
	if schedCount > 0 {
		m.startSchedulerIfNeeded()
	}
	// Emit lifecycle observability events for every successfully-
	// registered init entry so the operator sees them in the log /
	// renderer panel.
	for _, w := range host.Webhooks() {
		m.emitAsyncLifecycle(key, "engine_webhook_registered", asyncreg.KindWebhook, w.Path, asyncreg.OriginInit, w)
	}
	for _, j := range host.Schedules() {
		m.emitAsyncLifecycle(key, "engine_schedule_registered", asyncreg.KindSchedule, j.JobID, asyncreg.OriginInit, j)
	}
	utils.Log("session", fmt.Sprintf("commitHostInitAsyncDecls: ext=%s key=%s webhooks=%d schedules=%d errs=%d",
		host.Name(), key, hooksCount, schedCount, len(errs)))
}

// emitAsyncLifecycle publishes a registered/deregistered event onto
// the session's emit channel.
func (m *Manager) emitAsyncLifecycle(key, evType string, kind asyncreg.Kind, id string, origin asyncreg.Origin, decl interface{}) {
	declJSON, _ := json.Marshal(decl)
	m.emit(key, types.EngineEvent{
		Type:        evType,
		AsyncKind:   string(kind),
		AsyncID:     id,
		AsyncOrigin: string(origin),
		AsyncDecl:   declJSON,
	})
}

// startWebhookServerIfNeeded starts the listener when any host has a
// registered route and the config doesn't force-disable. Idempotent.
func (m *Manager) startWebhookServerIfNeeded() {
	m.asyncMu.Lock()
	srv := m.webhookServer
	if srv == nil {
		m.asyncMu.Unlock()
		return
	}
	if m.config != nil && m.config.Webhooks != nil && m.config.Webhooks.Enabled != nil && !*m.config.Webhooks.Enabled {
		m.asyncMu.Unlock()
		utils.Debug("session", "webhook listener forced OFF by config")
		return
	}
	m.asyncMu.Unlock()
	if err := srv.Start(); err != nil {
		utils.Error("session", fmt.Sprintf("startWebhookServerIfNeeded: Start failed: %v", err))
	}
}

// startSchedulerIfNeeded starts the tick loop when any host has a
// registered job. Idempotent.
func (m *Manager) startSchedulerIfNeeded() {
	m.asyncMu.Lock()
	sch := m.scheduler
	m.asyncMu.Unlock()
	if sch == nil {
		return
	}
	sch.Start()
}

// unwireHostAsync removes a host from both subsystems at teardown.
// Safe to call when the host was never wired (no-op via AddHost
// idempotency in reverse).
func (m *Manager) unwireHostAsync(host *extension.Host) {
	m.asyncMu.Lock()
	srv := m.webhookServer
	sch := m.scheduler
	m.asyncMu.Unlock()
	if srv != nil {
		srv.RemoveHost(host)
	}
	if sch != nil {
		sch.RemoveHost(host)
	}
}

// webhookConfigFrom translates the EngineRuntimeConfig.Webhooks
// block into a webhooks.Config. Zero-valued fields inherit the
// package defaults.
func webhookConfigFrom(rc *types.EngineRuntimeConfig) webhooks.Config {
	var cfg webhooks.Config
	if rc == nil || rc.Webhooks == nil {
		return cfg
	}
	w := rc.Webhooks
	cfg.Port = w.Port
	cfg.BindInterface = w.BindInterface
	cfg.DefaultMaxBodyBytes = w.DefaultMaxBodyBytes
	if w.FireTimeoutMs > 0 {
		// Reusing the time-millis conversion locally to avoid a
		// dependency on time in this small block.
		cfg.FireTimeout = millisToDuration(w.FireTimeoutMs)
	}
	return cfg
}

// scheduleConfigFrom translates the EngineRuntimeConfig.Scheduling
// block into a scheduling.Config.
func scheduleConfigFrom(rc *types.EngineRuntimeConfig) scheduling.Config {
	var cfg scheduling.Config
	if rc == nil || rc.Scheduling == nil {
		return cfg
	}
	s := rc.Scheduling
	cfg.DefaultTz = s.DefaultTz
	if s.FireTimeoutMs > 0 {
		cfg.FireTimeout = millisToDuration(s.FireTimeoutMs)
	}
	cfg.CatchUpEnabled = s.CatchUpEnabled
	// PersistDir defaults to ~/.ion/scheduler when not overridden.
	cfg.PersistDir = defaultSchedulerPersistDir()
	return cfg
}
