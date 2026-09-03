package session

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// loadAndWireExtensions loads extension subprocesses, wires their hooks and
// callbacks, and fires session_start. Safe to call on both new and existing
// sessions — the caller must ensure the session does not already have a
// loaded extension group.
func (m *Manager) loadAndWireExtensions(s *engineSession, key string, config types.EngineConfig, plans []extension.ResolvedExtensionPlan) {
	extPaths := plans
	group := extension.NewExtensionGroup()
	for _, plan := range extPaths {
		extPath := plan.Path
		m.emit(key, types.EngineEvent{
			Type:         "engine_working_message",
			EventMessage: fmt.Sprintf("Loading extension: %s", filepath.Base(filepath.Dir(extPath))),
		})
		host := extension.NewHost()
		buildIdentity := m.engineBuildIdentitySnapshot()
		if m.config != nil && m.config.Timeouts != nil {
			host.SetRPCTimeout(m.config.Timeouts.ExtensionRpc())
		}

		// Enterprise required hooks prepended before extension loads
		if m.config != nil && m.config.Enterprise != nil && len(m.config.Enterprise.RequiredHooks) > 0 {
			hooks := make([]struct{ Event, Handler string }, len(m.config.Enterprise.RequiredHooks))
			for i, h := range m.config.Enterprise.RequiredHooks {
				hooks[i] = struct{ Event, Handler string }{Event: h.Event, Handler: h.Handler}
			}
			host.RegisterRequiredHooks(hooks)
		}

		host.SetEngineBuildIdentity(buildIdentity)
		extCfg := &extension.ExtensionConfig{
			ExtensionDir:     filepath.Dir(extPath),
			WorkingDirectory: config.WorkingDirectory,
			BuildIdentity:    buildIdentity,
		}
		// Enterprise extension allowlist (feature 0011 / D-020, issue #308):
		// carry the sealed allowlist into the host so Host.Load can enforce it
		// at the single load chokepoint. Empty means no restriction.
		if m.config != nil && m.config.Enterprise != nil && len(m.config.Enterprise.ExtensionAllowlist) > 0 {
			extCfg.ExtensionAllowlist = m.config.Enterprise.ExtensionAllowlist
		}
		if err := host.Load(extPath, extCfg); err != nil {
			stderrTail := host.StderrTail()
			// A block by the enterprise extension allowlist is surfaced with a
			// distinct error code so clients can tell "policy refused to load
			// this extension" apart from a genuine load failure (crash, bad
			// manifest, transpile error).
			errorCode := "extension_load_failed"
			if errors.Is(err, extension.ErrExtensionBlocked) {
				errorCode = "extension_blocked"
				utils.LogWithFields(utils.LevelInfo, "session", "extension blocked by enterprise allowlist", map[string]any{"ext_path": extPath, "error": err.Error()})
				// Enforcement audit event (feature 0010 audit clause). Nil-safe
				// on the session collector.
				if s.telemetry != nil {
					reason := "name"
					if strings.Contains(err.Error(), "reason: hash") {
						reason = "hash"
					}
					s.telemetry.Event(telemetry.EnforcementExtensionBlocked, map[string]any{
						// host.Name() is the manifest-resolved identifier (manifest.Name
						// else dir basename) — the same identifier checkExtensionAllowlist
						// checked. filepath.Base(filepath.Dir(extPath)) would give the
						// directory name, which differs from the manifest name when
						// extension.json declares a different name than the directory.
						"subject": host.Name(),
						"source":  "allowlist",
						"reason":  reason,
					}, nil)
				}
			} else {
				utils.LogWithFields(utils.LevelError, "session", "extension load failed", map[string]any{"ext_path": extPath, "error": err.Error()})
			}
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("extension load failed: %s", err.Error()),
				ErrorCode:    errorCode,
				StderrTail:   stderrTail,
			})
			continue
		}
		// extension.coldstart telemetry (family 4e): the host is up and its init
		// handshake completed. Nil-safe on the session collector.
		m.emitExtensionColdstartTelemetry(s, key, host, extPath)
		capturedKey := key
		host.SetOnDeath(func(h *extension.Host) {
			m.handleHostDeath(capturedKey, h)
		})
		// Wire async-trigger lifecycle (D-010 / D-011) BEFORE
		// committing any init-time webhook/schedule declarations so
		// the registry's veto pipeline fires through the SDK with a
		// real session context.
		m.wireHostAsync(key, host)
		m.commitHostInitAsyncDecls(key, host)
		// Commit resource declarations (D-007) onto the session broker.
		if errs := host.CommitPendingResourceDecls(s.resourceBroker); len(errs) != 0 {
			for _, err := range errs {
				m.emit(key, types.EngineEvent{
					Type:         "engine_error",
					EventMessage: fmt.Sprintf("resource declaration rejected: %v", err),
					ErrorCode:    "resource_init_rejected",
				})
			}
		}
		group.Add(host)
	}
	if group.IsEmpty() {
		return
	}

	// Capture extension identity from the loaded hosts. Both fields are final
	// by the time Load() returns: Version comes from extension.json (build-time
	// constant), and Name resolves manifest → init-handshake → directory
	// basename (host_lifecycle.go / parseInitResult). Populating the name here
	// is what makes telemetry attribution (run.complete / llm.call
	// ctx.extension) work in a real session: the engine_status broadcast path
	// below (SetPersistentEmit handler) only fires for emissions made OUTSIDE
	// a hook context — ext/emit prefers the active hook ctx.Emit
	// (host_rpc.go), which bypasses that handler — so extensions that
	// broadcast their name from inside session_start/before_prompt hooks
	// (the normal case) would otherwise never populate s.extensionName.
	// The broadcast handler remains as a friendly-name override for
	// persistent-context emissions.
	m.mu.Lock()
	for _, h := range group.Hosts() {
		if s.extensionName == "" && h.Name() != "" {
			s.extensionName = h.Name()
		}
		if s.extensionVersion == "" && h.Version() != "" {
			s.extensionVersion = h.Version()
		}
	}
	m.mu.Unlock()

	// Wire send_message and persistent emit on each host
	for _, host := range group.Hosts() {
		capturedKey := key
		// Bind session/conversation IDs so extension log notifications are
		// stamped with the correlating IDs (unified log schema).
		host.BindSession(s.key, s.conversationID)
		host.SetOnSendMessage(func(payload extension.SendPromptPayload) {
			// Shared dispatch body (prompt_options.go) so the active-hook path
			// and this fallback path produce identical run configuration.
			// Model + bash-allowlist additions flow through; nothing is dropped.
			go m.dispatchSendPromptPayload(capturedKey, "start_session", payload)
		})
		// Wire the per-handler hook_latency telemetry sink. The collector's
		// Event signature matches SetTelemetrySink exactly; when the session has
		// no collector the sink stays nil and callHook emits nothing.
		if s.telemetry != nil {
			host.SetTelemetrySink(s.telemetry.Event)
		}
		host.SetPersistentEmit(func(ev types.EngineEvent) {
			if ev.Type == "engine_agent_state" {
				m.cacheExtStatesAndEmit(capturedKey, s, ev.Agents)
				return
			}
			if ev.Type == "engine_status" && ev.Fields != nil && ev.Fields.ExtensionName != "" {
				m.mu.Lock()
				s.extensionName = ev.Fields.ExtensionName
				m.mu.Unlock()
			}
			m.emit(capturedKey, ev)
		})

		// Persistent publish for ext/publish_resource calls from
		// onComplete callbacks (after the run exits, ctxStack is empty).
		// Always publish to session broker first, then fan out to global
		// broker for reliable delivery (per-session subscriptions often
		// fail because the producer only exists on one session's broker).
		host.SetPersistentPublishResource(func(kind string, delta types.ResourceDelta) error {
			if s.resourceBroker != nil {
				if err := s.resourceBroker.PublishFrom(kind, delta.Item.Producer, delta); err != nil {
					return err
				}
			} else {
				return fmt.Errorf("no broker available")
			}
			if m.globalBroker != nil {
				m.globalBroker.PublishDirect(kind, delta)
			}
			return nil
		})

		host.SetPersistentAckDispatchLost(func(dispatchID string) {
			m.persistLostNoticeState(s.conversationID, dispatchID, "sent")
		})

		wirePersistentNotification(host, m, s, capturedKey)

		// Deferred schedule_missed handlers batch slots after their hook RPC
		// returns. Keep schedule control tied to this host's bound session.
		host.SetPersistentScheduleControl(
			func(jobID string) error { return m.fireScheduleForSession(capturedKey, jobID) },
			func(jobID string) ([]extension.ScheduleStatusEntry, error) {
				return m.scheduleStatusForSession(capturedKey, jobID)
			},
		)
		s.dispatchRegistry.SetDispatchLossRecallObserver(m.persistRecallIntents)

		// Persistent name-addressed recall for ext/recall_agent when the
		// parent run is idle. This retains the published extension API; callers
		// with a dispatch ID use the exact path below.
		host.SetPersistentRecall(func(name, reason string) (bool, error) {
			reg := s.dispatchRegistry
			if reg == nil {
				return false, fmt.Errorf("dispatch registry not available")
			}
			return reg.Recall(name, reason), nil
		})

		// Persistent ID-addressed recall for ext/recall_dispatch when the
		// parent run is idle. Same rationale as the name-based recall above;
		// this arm is what a consumer holding a dispatchId reaches.
		host.SetPersistentRecallByID(func(dispatchID, reason string) (bool, error) {
			reg := s.dispatchRegistry
			if reg == nil {
				return false, fmt.Errorf("dispatch registry not available")
			}
			found := reg.RecallByID(dispatchID, reason)
			return found, nil
		})

		// Persistent steer for ext/steer_dispatch when the parent run is idle.
		host.SetPersistentSteer(func(dispatchID, message string) (extension.SteerDispatchResult, error) {
			reg := s.dispatchRegistry
			if reg == nil {
				return extension.SteerDispatchResult{Outcome: "not_found"}, fmt.Errorf("dispatch registry not available")
			}
			outcome := reg.SteerByID(dispatchID, message)
			return extension.SteerDispatchResult{
				Delivered: outcome == extcontext.SteerOutcomeDelivered,
				Outcome:   string(outcome),
			}, nil
		})

		// Persistent name-based steer for ext/steer_dispatch_by_name when the parent run is idle.
		host.SetPersistentSteerByName(func(name, message string) (extension.SteerDispatchResult, error) {
			reg := s.dispatchRegistry
			if reg == nil {
				return extension.SteerDispatchResult{Outcome: "not_found"}, fmt.Errorf("dispatch registry not available")
			}
			outcome := reg.SteerByName(name, message)
			return extension.SteerDispatchResult{
				Delivered: outcome == extcontext.SteerOutcomeDelivered,
				Outcome:   string(outcome),
			}, nil
		})

		// Persistent self-steer for ext/steer_self. This one carries the
		// primary traffic rather than an idle-session edge case: a harness
		// calls ctx.steerSelf from a background dispatch's terminal callback,
		// which runs on the dispatch goroutine after the parent run already
		// exited, so the ctxStack is empty and the ctx arm cannot match.
		//
		// The resolution mirrors ctx.SteerSelf's depth-0 arm exactly (see
		// extcontext.NewExtContext): steer the live main run when there is
		// one, otherwise deliver as a fresh prompt on the idle session. Both
		// outcomes are "delivered" from the caller's perspective — the
		// distinction is only whether the message was injected mid-run
		// ("steered") or started a new run ("sent").
		host.SetPersistentSteerSelf(m.persistentSteerSelf(s, key))
	}

	m.mu.Lock()
	s.extGroup = group
	m.mu.Unlock()

	// Fire session_start
	m.emit(key, types.EngineEvent{
		Type:         "engine_working_message",
		EventMessage: "Initializing extensions...",
	})
	ctx := m.newExtContext(s, key)
	m.fireInitialIdentityChanged(s, key)
	group.FireSessionStart(ctx) //nolint:errcheck // errors logged internally by fireVoid/s.fire

	// Start the workspace filesystem watcher after extensions are loaded and
	// session_start has fired. Wiring after session_start lets extensions
	// observe the very first batch of events without a startup-race; the
	// watcher's own startup walk does not synthesize events for pre-existing
	// files, so consumers see only post-start activity.
	if release := m.startWorkspaceWatcher(s, key, group); release != nil {
		m.mu.Lock()
		s.fsWatcherRelease = release
		m.mu.Unlock()
	}

	// Discover capabilities from extensions
	caps := group.FireCapabilityDiscover(ctx)
	for _, cap := range caps {
		for _, host := range group.Hosts() {
			host.SDK().RegisterCapability(cap)
		}
	}

	// Phase 0.5: publish the initial command-registry snapshot, then wire
	// per-host onCommandsChange observers so subsequent mid-session
	// RegisterCommand calls also trigger snapshots.
	//
	// Ordering matters: by emitting the initial snapshot FIRST and wiring
	// observers SECOND, we collapse all init-time RegisterCommand calls
	// (which fire during host.Load() and during FireSessionStart) into a
	// single snapshot event rather than N events with intermediate states.
	// Mid-session registrations after this point each get their own
	// snapshot, which is the desired behavior — a consumer's cached view
	// only needs to be re-warmed for changes that happen after init
	// settles.
	m.emitCommandRegistry(key)
	for _, host := range group.Hosts() {
		capturedKey := key
		host.SetOnCommandsChange(func() {
			m.emitCommandRegistry(capturedKey)
		})
	}
	utils.LogWithFields(utils.LevelInfo, "session", "loadandwireextensions: wired oncommandschange observers for", map[string]any{"count": len(group.Hosts()), "key": key})
}
