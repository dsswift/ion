// engine_hosts_wiring.go — persistent fallbacks for an engine host.
//
// A session host's persistent callbacks (emit, notify, publish, recall, steer,
// schedule control) all reach the session it is bound to. An engine host has
// no session: its handlers run inside a headless session's context while a
// fire is live, and fall back to these callbacks once that context is popped
// (a dispatch's onComplete, a deferred schedule_missed batch). Each fallback
// resolves to something real or fails loudly; none silently drops.
package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (m *Manager) wireEngineHostPersistent(host *extension.Host) {
	name := host.Name()
	host.SetPersistentEmit(func(ev types.EngineEvent) {
		// A notification is for whoever is connected: fan it to every live
		// session. Anything else describes a conversation an engine host does
		// not have, so it is logged with its type and dropped.
		if ev.Type == "engine_notify" || ev.Type == "engine_notification" {
			m.fanOutToSessions(ev)
			return
		}
		utils.LogWithFields(utils.LevelWarn, engineHostsLogTag, "engine host event dropped: no session to carry it", map[string]any{"extension": name, "event_type": ev.Type})
	})
	host.SetPersistentNotify(func(opts types.NotifyOpts) error {
		if opts.Title == "" {
			return fmt.Errorf("notification title is required")
		}
		ev := types.EngineEvent{
			Type: "engine_notification", Push: true, PushTitle: opts.Title, PushBody: opts.Body,
			NotifyKind: opts.Kind, NotifyResourceID: opts.ResourceID, NotifyTitle: opts.Title,
			NotifyBody: opts.Body, NotifySound: opts.Sound, NotifyScope: opts.Scope,
		}
		if opts.TargetSessionKey != "" {
			m.mu.RLock()
			_, exists := m.sessions[opts.TargetSessionKey]
			m.mu.RUnlock()
			if exists {
				m.emit(opts.TargetSessionKey, ev)
				return nil
			}
			utils.LogWithFields(utils.LevelWarn, engineHostsLogTag, "notification target session not found; fanning out", map[string]any{"extension": name, "target_key": opts.TargetSessionKey})
		}
		m.fanOutToSessions(ev)
		return nil
	})
	host.SetPersistentPublishResource(func(kind string, delta types.ResourceDelta) error {
		m.mu.RLock()
		broker := m.engineHostBroker
		m.mu.RUnlock()
		if broker == nil {
			return fmt.Errorf("engine host broker not available")
		}
		if err := broker.PublishFrom(kind, delta.Item.Producer, delta); err != nil {
			return err
		}
		if m.globalBroker != nil {
			m.globalBroker.PublishDirect(kind, delta)
		}
		return nil
	})
	host.SetPersistentAckDispatchLost(func(dispatchID string) {
		utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "dispatch lost acknowledged by engine host", map[string]any{"extension": name, "dispatch_id": dispatchID})
	})
	host.SetPersistentScheduleControl(
		func(jobID string) error { return m.fireScheduleForEngineHost(name, jobID) },
		func(jobID string) ([]extension.ScheduleStatusEntry, error) {
			return m.scheduleStatusForEngineHost(name, jobID)
		},
	)
	// Dispatches an engine host starts live in headless sessions; a recall or
	// steer issued after the fire context is gone is found by walking them.
	host.SetPersistentRecall(func(agentName, reason string) (extension.RecallAgentResult, error) {
		result := m.controlDispatchAcrossSessions(func(reg *extcontext.DispatchRegistry) bool {
			return reg.RecallOwnedByName("", agentName, reason).Outcome != extcontext.RecallOutcomeNotFound
		})
		if !result {
			return extension.RecallAgentResult{Outcome: string(extcontext.RecallOutcomeNotFound)}, nil
		}
		return extension.RecallAgentResult{Outcome: string(extcontext.RecallOutcomeRecalled)}, nil
	})
	host.SetPersistentRecallByID(func(dispatchID, reason string) (extension.RecallDispatchResult, error) {
		var out extension.RecallDispatchResult
		found := m.controlDispatchAcrossSessions(func(reg *extcontext.DispatchRegistry) bool {
			r := reg.RecallOwnedByID("", dispatchID, reason)
			if r.Outcome == extcontext.RecallOutcomeNotFound {
				return false
			}
			out = extcontext.RecallDispatchResult(r)
			return true
		})
		if !found {
			return extension.RecallDispatchResult{Outcome: string(extcontext.RecallOutcomeNotFound)}, nil
		}
		return out, nil
	})
	host.SetPersistentSteer(func(dispatchID, message string) (extension.SteerDispatchResult, error) {
		var out extension.SteerDispatchResult
		found := m.controlDispatchAcrossSessions(func(reg *extcontext.DispatchRegistry) bool {
			r := reg.SteerOwnedByID("", dispatchID, message)
			if r.Outcome == "not_found" {
				return false
			}
			out = extcontext.SteerResult(r)
			return true
		})
		if !found {
			return extension.SteerDispatchResult{Outcome: "not_found"}, nil
		}
		return out, nil
	})
	host.SetPersistentSteerByName(func(agentName, message string) (extension.SteerDispatchResult, error) {
		var out extension.SteerDispatchResult
		found := m.controlDispatchAcrossSessions(func(reg *extcontext.DispatchRegistry) bool {
			r := reg.SteerOwnedByName("", agentName, message)
			if r.Outcome == "not_found" {
				return false
			}
			out = extcontext.SteerResult(r)
			return true
		})
		if !found {
			return extension.SteerDispatchResult{Outcome: "not_found"}, nil
		}
		return out, nil
	})
	host.SetPersistentSteerSelf(func(message, kind string) (extension.SteerDispatchResult, error) {
		utils.LogWithFields(utils.LevelWarn, engineHostsLogTag, "steer_self refused: an engine host has no run of its own", map[string]any{"extension": name, "kind": kind})
		return extension.SteerDispatchResult{Outcome: "not_found"}, fmt.Errorf("steer_self is not available on an engine host; use the fire context")
	})
}

// fanOutToSessions emits one event to every live session. Used for
// notifications an engine host raises with no session of its own.
func (m *Manager) fanOutToSessions(ev types.EngineEvent) {
	m.mu.RLock()
	keys := make([]string, 0, len(m.sessions))
	for k, s := range m.sessions {
		if !s.headless {
			keys = append(keys, k)
		}
	}
	m.mu.RUnlock()
	utils.LogWithFields(utils.LevelInfo, engineHostsLogTag, "engine host event fanned out", map[string]any{"event_type": ev.Type, "count": len(keys)})
	for _, k := range keys {
		m.emit(k, ev)
	}
}

// controlDispatchAcrossSessions runs fn against every live session's dispatch
// registry until one claims the dispatch.
func (m *Manager) controlDispatchAcrossSessions(fn func(*extcontext.DispatchRegistry) bool) bool {
	m.mu.RLock()
	regs := make([]*extcontext.DispatchRegistry, 0, len(m.sessions))
	for _, s := range m.sessions {
		if s.dispatchRegistry != nil {
			regs = append(regs, s.dispatchRegistry)
		}
	}
	m.mu.RUnlock()
	for _, reg := range regs {
		if fn(reg) {
			return true
		}
	}
	return false
}

// fireScheduleForEngineHost is ctx.fireSchedule for an engine host's own job.
func (m *Manager) fireScheduleForEngineHost(name, jobID string) error {
	m.asyncMu.Lock()
	sch := m.scheduler
	m.asyncMu.Unlock()
	if sch == nil {
		return fmt.Errorf("scheduler not available")
	}
	h := m.engineHostNamed(name)
	if h == nil {
		return fmt.Errorf("engine host %q not found", name)
	}
	if _, found := h.AsyncRegistry().ByID(asyncreg.KindSchedule, jobID); !found {
		return fmt.Errorf("schedule job %q not found on engine host %q", jobID, name)
	}
	return sch.FireScheduleNow(h, jobID)
}

// scheduleStatusForEngineHost is ctx.getScheduleStatus for an engine host.
func (m *Manager) scheduleStatusForEngineHost(name, jobID string) ([]extension.ScheduleStatusEntry, error) {
	m.asyncMu.Lock()
	sch := m.scheduler
	m.asyncMu.Unlock()
	h := m.engineHostNamed(name)
	if sch == nil || h == nil {
		return []extension.ScheduleStatusEntry{}, nil
	}
	now := sch.Now()
	entries := []extension.ScheduleStatusEntry{}
	for _, d := range h.AsyncRegistry().List(asyncreg.KindSchedule) {
		job, ok := d.(extension.ScheduleJob)
		if !ok || (jobID != "" && job.JobID != jobID) {
			continue
		}
		entries = append(entries, sch.ScheduleStatusFor(h, job, now))
	}
	return entries, nil
}
