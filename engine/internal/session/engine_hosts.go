// engine_hosts.go — the engine-scoped extension hosts.
//
// An extension whose manifest declares scope "engine" or "both" runs one host
// that belongs to the engine process, not to a conversation. The engine spawns
// those hosts once at boot (StartEngineHosts) from the extensionHosts config
// block and stops them at shutdown. Their schedules and webhooks fire into
// headless sessions (headless_session.go) minted per fire under the run-as
// principal (run_as_principal.go). Tools, commands, and session hooks do not
// exist on an engine host; the extension's session half carries those.
package session

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const engineHostsLogTag = "session.engine_hosts"

// engineHostsKey is the synthetic key the engine host group's resource broker
// is listed under. It can never collide with a session key, which clients
// mint, because a session key is never empty-prefixed with this label.
const engineHostsKey = "engine-hosts"

// engineHostRespawnDelay is the pause before a dead engine host is respawned.
// There is no run to wait for, so the respawn is immediate but not a tight
// loop: the strike budget on Host.Respawn still bounds repeated crashes.
const engineHostRespawnDelay = time.Second

// StartEngineHosts spawns every configured engine-scoped host. It is called
// once, after the socket is up, so a failure here is logged against a running
// engine rather than aborting boot: conversations keep working, engine hosts
// stay off until the config is fixed. The returned error names what failed.
func (m *Manager) StartEngineHosts(ctx context.Context) error {
	m.mu.RLock()
	cfg := m.config
	m.mu.RUnlock()
	if cfg == nil || cfg.ExtensionHosts == nil {
		utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "no extensionhosts block; engine hosts off", nil)
		return nil
	}
	hostsCfg := cfg.ExtensionHosts
	principal, err := resolveRunAsPrincipal(ctx, hostsCfg.RunAs, cfg.Auth)
	if err != nil {
		utils.LogWithFields(utils.LevelError, engineHostsLogTag, "engine hosts not started: run-as principal unresolved", map[string]any{"error": err.Error()})
		return fmt.Errorf("engine hosts: %w", err)
	}
	plans, err := extension.PreflightExtensions(hostsCfg.Extensions)
	if err != nil {
		utils.LogWithFields(utils.LevelError, engineHostsLogTag, "engine hosts not started: extension preflight refused", map[string]any{"error": err.Error()})
		return fmt.Errorf("engine hosts: %w", err)
	}

	group := extension.NewExtensionGroup()
	broker := resource.NewBroker()
	m.mu.Lock()
	m.engineHosts = group
	m.engineHostBroker = broker
	m.runAsPrincipal = principal
	m.mu.Unlock()
	m.watchWorkspaceProducers(engineHostsKey, broker)

	var loadErrs []error
	for _, plan := range plans {
		if !plan.Manifest.SpawnsEngineHost() {
			utils.LogWithFields(utils.LevelError, engineHostsLogTag, "extension refused: manifest scope has no engine half", map[string]any{"extension": plan.Identifier, "ext_path": plan.Path, "manifest_scope": plan.Manifest.EffectiveScope()})
			loadErrs = append(loadErrs, fmt.Errorf("extension %q: manifest scope %q has no engine half", plan.Identifier, plan.Manifest.EffectiveScope()))
			continue
		}
		host, err := m.loadEngineHost(plan, hostsCfg, principal)
		if err != nil {
			loadErrs = append(loadErrs, err)
			continue
		}
		group.Add(host)
	}
	if group.IsEmpty() {
		utils.LogWithFields(utils.LevelError, engineHostsLogTag, "no engine host loaded", map[string]any{"configured": len(hostsCfg.Extensions), "error": len(loadErrs)})
		return errors.Join(loadErrs...)
	}
	m.fireEngineHostsIdentity(group, principal)
	utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "engine hosts started", map[string]any{"count": len(group.Hosts()), "configured": len(hostsCfg.Extensions), "run_as": principalSubject(principal)})
	return errors.Join(loadErrs...)
}

// loadEngineHost spawns and wires one engine host. Every failure is logged
// with the extension path; the error is also returned so the caller can
// report the full set.
func (m *Manager) loadEngineHost(plan extension.ResolvedExtensionPlan, hostsCfg *types.ExtensionHostsConfig, principal *types.SessionPrincipal) (*extension.Host, error) {
	host := extension.NewHost()
	buildIdentity := m.engineBuildIdentitySnapshot()
	m.mu.RLock()
	timeouts := m.config.Timeouts
	m.mu.RUnlock()
	if timeouts != nil {
		host.SetRPCTimeout(timeouts.ExtensionRpc())
	}
	host.SetEngineBuildIdentity(buildIdentity)
	host.SetScope(extension.HostScopeEngine, plan.Manifest.EffectiveScope())
	extCfg := &extension.ExtensionConfig{
		ExtensionDir:     plan.Directory,
		WorkingDirectory: hostsCfg.Session.WorkingDirectory,
		Model:            hostsCfg.Session.Model,
		BuildIdentity:    buildIdentity,
		Scope:            string(extension.HostScopeEngine),
	}
	if policyCfg := m.policyConfig(principal); policyCfg != nil && policyCfg.Enterprise != nil && len(policyCfg.Enterprise.ExtensionAllowlist) > 0 {
		extCfg.ExtensionAllowlist = policyCfg.Enterprise.ExtensionAllowlist
	}
	if err := host.Load(plan.Path, extCfg); err != nil {
		utils.LogWithFields(utils.LevelError, engineHostsLogTag, "engine host load failed", map[string]any{"extension": plan.Identifier, "ext_path": plan.Path, "error": err.Error(), "stderr_tail": host.StderrTail()})
		return nil, fmt.Errorf("engine host %q: %w", plan.Identifier, err)
	}
	host.SetOnDeath(func(h *extension.Host) { m.handleEngineHostDeath(h) })
	m.wireEngineHost(host)
	m.commitEngineHostDecls(host)
	utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "engine host loaded", map[string]any{"extension": host.Name(), "ext_path": plan.Path, "manifest_scope": plan.Manifest.EffectiveScope(), "schedules": len(host.Schedules()), "webhooks": len(host.Webhooks()), "resources": len(host.Resources())})
	return host, nil
}

// wireEngineHost installs the host-side plumbing an engine host needs: the
// async lifecycle hooks with a stub context (there is no session), the
// scheduler and webhook server registration, and the persistent fallbacks
// (engine_hosts_wiring.go).
func (m *Manager) wireEngineHost(host *extension.Host) {
	host.SetSessionKey("")
	host.SetOnLifecycleHook(func(event string, info extension.AsyncRegistrationInfo) error {
		return m.fireLifecycleHookSDK(event, &extension.Context{}, info, host)
	})
	server, scheduler := m.ensureAsyncSubsystems()
	server.AddHost(host)
	scheduler.AddHost(host)
	m.wireEngineHostPersistent(host)
	utils.LogWithFields(utils.LevelDebug, engineHostsLogTag, "engine host wired", map[string]any{"extension": host.Name()})
}

// commitEngineHostDecls flushes the init-time schedule, webhook, and resource
// declarations. Rejections are logged; there is no session to emit to.
func (m *Manager) commitEngineHostDecls(host *extension.Host) {
	for _, err := range host.CommitPendingAsyncDecls() {
		utils.LogWithFields(utils.LevelError, engineHostsLogTag, "engine host async declaration rejected", map[string]any{"extension": host.Name(), "error": err.Error()})
	}
	m.mu.RLock()
	broker := m.engineHostBroker
	m.mu.RUnlock()
	for _, err := range host.CommitPendingResourceDecls(broker) {
		utils.LogWithFields(utils.LevelError, engineHostsLogTag, "engine host resource declaration rejected", map[string]any{"extension": host.Name(), "error": err.Error()})
	}
	if host.AsyncRegistry().Count(asyncreg.KindWebhook)+host.AsyncRegistry().Count(asyncreg.KindSchedule) > 0 {
		m.startWebhookServerIfNeeded()
		m.startSchedulerIfNeeded()
	}
	for _, j := range host.Schedules() {
		utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "engine host schedule registered", map[string]any{"extension": host.Name(), "schedule_job_id": j.JobID, "kind": j.Kind})
	}
	for _, w := range host.Webhooks() {
		utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "engine host webhook registered", map[string]any{"extension": host.Name(), "path": w.Path})
	}
}

// fireEngineHostsIdentity tells every engine host who its headless sessions
// act as. The firing carries an empty SessionKey, like the process-level
// operator-identity firing, because it describes the host, not a session.
func (m *Manager) fireEngineHostsIdentity(group *extension.ExtensionGroup, principal *types.SessionPrincipal) {
	identity := auth.FromSessionPrincipal(principal)
	for _, host := range group.Hosts() {
		if !host.DeclaresHook(extension.HookIdentityChanged) {
			continue
		}
		info := extension.IdentityChangedInfo{Identity: identity, Reason: "run_as"}
		if err := host.FireIdentityChanged(&extension.Context{}, info); err != nil {
			utils.LogWithFields(utils.LevelWarn, engineHostsLogTag, "engine host identity hook failed", map[string]any{"extension": host.Name(), "error": err.Error()})
			continue
		}
		utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "engine host identity hook applied", map[string]any{"extension": host.Name(), "run_as": principalSubject(principal)})
	}
}

// handleEngineHostDeath respawns a dead engine host after a short delay.
// There is no turn to wait for; the strike budget bounds a crash loop and a
// permanent death is logged as such.
func (m *Manager) handleEngineHostDeath(h *extension.Host) {
	exitCode, signal := h.LastExit()
	utils.LogWithFields(utils.LevelWarn, engineHostsLogTag, "engine host died", map[string]any{"extension": h.Name(), "exit_code": exitCode, "signal": signal, "stderr_tail": h.StderrTail()})
	time.Sleep(engineHostRespawnDelay)
	m.mu.RLock()
	group := m.engineHosts
	m.mu.RUnlock()
	if group == nil {
		utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "engine host not respawned: hosts stopped", map[string]any{"extension": h.Name()})
		return
	}
	attempt, err := h.Respawn()
	if err != nil {
		if errors.Is(err, extension.ErrBudgetExceeded) {
			utils.LogWithFields(utils.LevelError, engineHostsLogTag, "engine host respawn budget exceeded; host is dead permanently", map[string]any{"extension": h.Name(), "attempt": attempt})
			return
		}
		utils.LogWithFields(utils.LevelError, engineHostsLogTag, "engine host respawn failed", map[string]any{"extension": h.Name(), "attempt": attempt, "error": err.Error()})
		return
	}
	h.ResetAsyncRegistrations()
	m.commitEngineHostDecls(h)
	m.mu.RLock()
	principal := m.runAsPrincipal
	m.mu.RUnlock()
	m.fireEngineHostsIdentity(group, principal)
	utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "engine host respawned", map[string]any{"extension": h.Name(), "attempt": attempt})
}

// stopEngineHosts removes every engine host from the async subsystems and
// disposes the processes. Called from Shutdown after the sessions are gone.
func (m *Manager) stopEngineHosts() {
	m.mu.Lock()
	group := m.engineHosts
	m.engineHosts = nil
	m.engineHostBroker = nil
	m.mu.Unlock()
	if group == nil {
		return
	}
	m.asyncMu.Lock()
	srv := m.webhookServer
	sch := m.scheduler
	m.asyncMu.Unlock()
	for _, h := range group.Hosts() {
		if sch != nil {
			sch.RemoveHost(h)
		}
		if srv != nil {
			srv.RemoveHost(h)
		}
	}
	group.Close()
	utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "engine hosts stopped", map[string]any{"count": len(group.Hosts())})
}

// EngineHosts returns the live engine host group, or nil when none started.
func (m *Manager) EngineHosts() *extension.ExtensionGroup {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.engineHosts
}

// engineHostNamed finds an engine host by extension name.
func (m *Manager) engineHostNamed(name string) *extension.Host {
	group := m.EngineHosts()
	if group == nil {
		return nil
	}
	for _, h := range group.Hosts() {
		if h.Name() == name {
			return h
		}
	}
	return nil
}

func principalSubject(p *types.SessionPrincipal) string {
	if p == nil {
		return ""
	}
	return p.Subject
}

// extensionLabel is the short name an engine host's sessions are keyed on.
func extensionLabel(h *extension.Host) string {
	if name := h.Name(); name != "" {
		return name
	}
	return filepath.Base(h.ExtensionDir())
}

// FireEngineHostSchedule fires one of an engine host's jobs now. It is the
// wire-free way a test or an operator tool triggers a headless run.
func (m *Manager) FireEngineHostSchedule(extensionName, jobID string) error {
	return m.fireScheduleForEngineHost(extensionName, jobID)
}

// SessionHosts returns the extension hosts loaded into a session, or nil.
func (m *Manager) SessionHosts(key string) []*extension.Host {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok || s.extGroup == nil {
		return nil
	}
	return s.extGroup.Hosts()
}
