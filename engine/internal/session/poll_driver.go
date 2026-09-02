package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

var pollCounter atomic.Int64

type activePoll struct {
	state        types.PollState
	checkCommand string
	model        string
	interval     time.Duration
	deadline     time.Time
	maxAttempts  int
	timer        *time.Timer
	cwd          string
	// owner is the dispatch ID of the run that started this poll, or "" for
	// the root session. A run parks only on the polls it started (see
	// OutstandingPollIDsFor).
	//
	// Without this attribution every run in the session parked on every poll,
	// and because Poll is itself implemented as a dispatched child
	// ("poll-check"), that child parked on the very poll it was dispatched to
	// resolve. The poll could never finish, so the child waited the full
	// deadline and returned "stuck" -- a self-deadlock that burned the whole
	// 30-minute budget on every poll started inside a dispatch.
	owner string
}

type pollChildAnswer struct {
	Verdict  types.PollVerdict `json:"verdict"`
	Evidence string            `json:"evidence"`
	Reason   string            `json:"reason,omitempty"`
}

// startPoll registers a poll and runs its first attempt.
//
// It takes no parent model. The poll child's model is resolved from operator
// configuration only (caller request, then engine poll config, then the tier
// chain in resolvePollModel), never inherited from the conversation — see
// resolvePollModel for why.
//
// owner is the dispatch ID of the run starting the poll, or "" for the root
// session. It decides which runs park on this poll (see OutstandingPollIDsFor)
// and is what keeps Poll from deadlocking itself: Poll resolves its intent by
// dispatching a poll-check child, and a session-wide park set made that child
// park on the very poll it was dispatched to resolve.
func (m *Manager) startPoll(s *engineSession, key, owner string, request tools.PollRequest, cwd string) (string, error) {
	cfg := m.pollConfig()
	m.mu.Lock()
	if len(s.activePolls) >= cfg.MaxActivePerSession {
		m.mu.Unlock()
		return "", fmt.Errorf("poll limit reached: session allows %d active polls", cfg.MaxActivePerSession)
	}
	interval := request.Interval
	if interval <= 0 || interval < cfg.MinInterval() {
		interval = cfg.MinInterval()
	}
	deadline := request.Deadline
	if deadline <= 0 || deadline > cfg.MaxDeadline() {
		deadline = cfg.MaxDeadline()
	}
	attempts := request.MaxAttempts
	if attempts <= 0 || attempts > cfg.MaxAttempts {
		attempts = cfg.MaxAttempts
	}
	model := selectPollModel(m, cfg, request)
	id := fmt.Sprintf("poll-%d-%d", pollCounter.Add(1), time.Now().UnixMilli())
	poll := &activePoll{state: types.PollState{PollID: id, Intent: request.Intent, DeadlineAt: time.Now().Add(deadline).UnixMilli()}, checkCommand: request.CheckCommand, model: model, interval: interval, deadline: time.Now().Add(deadline), maxAttempts: attempts, cwd: cwd, owner: owner}
	if s.activePolls == nil {
		s.activePolls = make(map[string]*activePoll)
	}
	s.activePolls[id] = poll
	m.mu.Unlock()
	m.emit(key, types.EngineEvent{Type: "engine_poll_started", PollStarted: &poll.state})
	m.emitPollStatus(key, "poll_started")
	utils.LogWithFields(utils.LevelInfo, "session.poll", "poll registered", map[string]any{"session_id": key, "poll_id": id, "owner_dispatch_id": owner, "interval_ms": interval.Milliseconds(), "deadline_ms": deadline.Milliseconds(), "max_attempts": attempts})
	m.runPollAttempt(key, id)
	return id, nil
}

func (m *Manager) pollConfig() types.PollConfig {
	if m.config == nil {
		return types.PollDefaults()
	}
	return m.config.Poll.Resolved()
}

// selectPollModel applies the poll child's model precedence: an explicit
// caller request, then the operator's poll.model, then the tier chain in
// resolvePollModel. The conversation's model is not a rung — see
// resolvePollModel for why.
func selectPollModel(m *Manager, cfg types.PollConfig, request tools.PollRequest) string {
	if request.Model != "" {
		return request.Model
	}
	if cfg.Model != "" {
		return cfg.Model
	}
	return m.resolvePollModel()
}

// resolvePollModel picks the poll child's model when neither the caller nor the
// operator named one. It walks types.PollModelTierPreference and takes the
// first configured tier, then falls back to the engine default model.
//
// The parent model is deliberately NOT in this chain. A poll child judges
// pre-gathered evidence against a fixed verdict vocabulary, so inheriting the
// parent would price mechanical work at whatever the conversation runs on — a
// premium-model conversation would silently buy premium-model polling on every
// attempt. The engine default is the last resort because it is operator
// configuration, which the parent model is not.
//
// An empty return is valid and means "no engine default configured"; the shared
// dispatch seam applies its own DefaultModel fallback in that case.
func (m *Manager) resolvePollModel() string {
	for _, tier := range types.PollModelTierPreference {
		entry, ok := modelconfig.LookupTier(tier)
		if !ok {
			utils.LogWithFields(utils.LevelDebug, "session.poll", "poll model tier not configured; trying next", map[string]any{"tier": tier})
			continue
		}
		utils.LogWithFields(utils.LevelInfo, "session.poll", "poll model resolved from tier", map[string]any{"tier": entry.Name, "model": entry.Model})
		return entry.Model
	}
	var fallback string
	if m.config != nil {
		fallback = m.config.DefaultModel
	}
	utils.LogWithFields(utils.LevelInfo, "session.poll", "poll model fell back to engine default", map[string]any{"model": fallback, "tiers_tried": types.PollModelTierPreference})
	return fallback
}

var pollEvidenceTools = []string{
	"Bash", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "LSP",
	"ListMcpResources", "ReadMcpResource", "SearchHistory",
	"WorktreeList", "WorktreeCommits", "WorktreeDiff",
}

func (m *Manager) pollDispatchOptions(key, id, prompt, model, cwd string) extension.DispatchAgentOpts {
	includeContext := false
	return extension.DispatchAgentOpts{
		Name: "poll-check", Task: prompt, Model: model, ProjectPath: cwd,
		DisplayName: "Poll check", Detached: true, Background: true,
		AllowedTools:   append([]string(nil), pollEvidenceTools...),
		SubAgentPolicy: "allowlist", AllowedSubAgents: []string{},
		// Poll is a bounded evidence judge. pollChildPrompt already carries its
		// complete intent, check command, raw evidence, and verdict vocabulary.
		// Repository contribution rules and global workflow prose cannot change
		// that judgment, and context injection repeats the files on every attempt
		// (measured at 128,480 bytes per attempt). Disable both layers explicitly.
		ContextPolicy: &extension.ContextPolicy{
			IncludeGlobalContext:  &includeContext,
			IncludeProjectContext: &includeContext,
		},
		OnComplete: func(result extension.DispatchAgentResult) { m.handlePollResult(key, id, result.Output) },
		OnError: func(failure extension.DispatchError) {
			m.finishPoll(key, id, pollChildAnswer{Verdict: types.PollVerdictStuck, Evidence: failure.Message, Reason: "poll child failed"})
		},
		OnRecall: func(info extension.RecallInfo) {
			m.finishPoll(key, id, pollChildAnswer{Verdict: types.PollVerdictStuck, Evidence: info.Reason, Reason: "poll child recalled"})
		},
	}
}

func (m *Manager) runPollAttempt(key, id string) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return
	}
	poll, ok := s.activePolls[id]
	if !ok {
		m.mu.Unlock()
		return
	}
	if time.Now().After(poll.deadline) || poll.state.Attempt >= poll.maxAttempts {
		m.mu.Unlock()
		m.finishPoll(key, id, pollChildAnswer{Verdict: types.PollVerdictExhausted, Evidence: "The configured poll deadline or attempt budget was reached.", Reason: "budget exhausted"})
		return
	}
	poll.state.Attempt++
	attempt := poll.state.Attempt
	model := poll.model
	cwd := poll.cwd
	intent := poll.state.Intent
	check := poll.checkCommand
	owner := poll.owner
	m.mu.Unlock()

	evidence, commandFailure := runPollCheckCommand(check, cwd, time.Until(poll.deadline))
	if commandFailure != "" {
		m.finishPoll(key, id, pollChildAnswer{Verdict: types.PollVerdictFailed, Evidence: evidence, Reason: commandFailure})
		return
	}
	prompt := pollChildPrompt(intent, check, evidence)
	m.mu.RLock()
	s, exists := m.sessions[key]
	if !exists {
		m.mu.RUnlock()
		return
	}
	acc := &sessionAccessor{m: m, s: s, key: key}
	registry := s.dispatchRegistry
	m.mu.RUnlock()
	// Parent the poll-check child to the run that started the poll.
	//
	// Hardcoding (0, "") registered every poll-check as a root-level dispatch,
	// so a poll started by a dispatched agent showed up in the orchestrator's
	// agent panel as a sibling of that agent instead of its child. The
	// misparenting was not only cosmetic: AgentStatus reported the judge as
	// top-level work, recall of a subtree could not reach it because ownership
	// resolves by parent chain, and its depth was counted from zero rather
	// than from the caller, so a deeply nested poll sidestepped the nesting
	// guard.
	//
	// owner is the poll's own attribution (empty for a root-session poll), and
	// the registry knows that dispatch's depth. An unknown owner -- the root,
	// or a dispatch that has already completed -- falls back to the root shape,
	// which is exactly the previous behavior for the case it was correct for.
	// pollDepth is the CALLER's depth, not the child's. BuildDispatchAgentFunc
	// takes currentDepth and derives childDepth = currentDepth + 1 itself, so
	// incrementing here double-counts: a poll started by a depth-1 agent asked
	// for a depth-3 child and the depth guard refused it at the cap of 3. The
	// judge never ran, so the poll could not resolve and its caller parked
	// until the backstop -- the same stall, from the opposite direction.
	pollDepth := 0
	if owner != "" && registry != nil {
		if d, known := registry.DepthOf(owner); known {
			pollDepth = d
		} else {
			utils.LogWithFields(utils.LevelDebug, "session.poll", "poll owner not in registry; parenting poll-check at root", map[string]any{
				"session_id": key, "poll_id": id, "owner_dispatch_id": owner,
			})
			owner = ""
		}
	}
	utils.LogWithFields(utils.LevelInfo, "session.poll", "poll check parentage resolved", map[string]any{
		"session_id": key, "poll_id": id, "parent_dispatch_id": owner, "count": pollDepth, "child_depth": pollDepth + 1, "attempt": attempt,
	})
	dispatch := extcontext.BuildDispatchAgentFunc(acc, registry, pollDepth, owner)
	result, err := dispatch(m.pollDispatchOptions(key, id, prompt, model, cwd))
	if err != nil {
		m.finishPoll(key, id, pollChildAnswer{Verdict: types.PollVerdictStuck, Evidence: err.Error(), Reason: "poll dispatch failed"})
		return
	}
	m.mu.Lock()
	if current, exists := m.sessions[key]; exists {
		if active := current.activePolls[id]; active != nil {
			active.state.ActiveDispatchID = result.DispatchID
		}
	}
	m.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "session.poll", "poll check dispatched", map[string]any{"session_id": key, "poll_id": id, "dispatch_id": result.DispatchID, "attempt": attempt})
}

func runPollCheckCommand(command, cwd string, remaining time.Duration) (string, string) {
	if command == "" {
		return "No check command was supplied. Inspect the available session evidence.", ""
	}
	if remaining <= 0 {
		return "The poll deadline elapsed before the check command could run.", "poll deadline elapsed"
	}
	result, err := tools.GetBashOperations().Exec(context.Background(), command, cwd, tools.ExecOptions{Timeout: remaining})
	if err != nil {
		return fmt.Sprintf("Check command failed to start: %s", err), "check command could not run"
	}
	output := strings.TrimSpace(result.Stdout + "\n" + result.Stderr)
	if output == "" {
		output = "(check command produced no output)"
	}
	if result.TimedOut {
		return output, "check command exceeded the poll deadline"
	}
	if result.ExitCode != 0 {
		output = fmt.Sprintf("Check command exit code: %d\n%s", result.ExitCode, output)
	}
	return output, ""
}

func pollChildPrompt(intent, command, evidence string) string {
	var b strings.Builder
	b.WriteString("You are a polling check agent. Inspect the watched work and return ONLY JSON with verdict, evidence, and optional reason. Verdict MUST be one of satisfied, failed, advancing, stuck. Evidence is required and must quote raw facts you used. Use stuck when you cannot decide; stuck means you are handing judgment back, not asserting the work is wedged. Only advancing permits another check. Your tools are for observation only: do not modify files, repositories, deployments, containers, clusters, services, or other watched state.\n\nIntent:\n")
	b.WriteString(intent)
	if command != "" {
		b.WriteString("\n\nThe engine already ran this check command:\n")
		b.WriteString(command)
	}
	b.WriteString("\n\nRaw evidence:\n")
	b.WriteString(evidence)
	return b.String()
}

func parsePollChildAnswer(output string) (pollChildAnswer, error) {
	var raw struct {
		Verdict  types.PollVerdict `json:"verdict"`
		Evidence json.RawMessage   `json:"evidence"`
		Reason   string            `json:"reason,omitempty"`
	}
	decoder := json.NewDecoder(strings.NewReader(strings.TrimSpace(output)))
	if err := decoder.Decode(&raw); err != nil {
		return pollChildAnswer{}, err
	}
	if len(raw.Evidence) == 0 || string(raw.Evidence) == "null" {
		return pollChildAnswer{Verdict: raw.Verdict, Reason: raw.Reason}, nil
	}
	var text string
	if raw.Evidence[0] == '"' {
		if err := json.Unmarshal(raw.Evidence, &text); err != nil {
			return pollChildAnswer{}, err
		}
	} else {
		var compact bytes.Buffer
		if err := json.Compact(&compact, raw.Evidence); err != nil {
			return pollChildAnswer{}, err
		}
		text = compact.String()
	}
	return pollChildAnswer{Verdict: raw.Verdict, Evidence: text, Reason: raw.Reason}, nil
}

func (m *Manager) handlePollResult(key, id, output string) {
	answer, err := parsePollChildAnswer(output)
	if err != nil || answer.Evidence == "" || !validPollVerdict(answer.Verdict) {
		m.finishPoll(key, id, pollChildAnswer{Verdict: types.PollVerdictStuck, Evidence: output, Reason: "poll child returned no valid evidenced verdict"})
		return
	}
	if answer.Verdict != types.PollVerdictAdvancing {
		m.finishPoll(key, id, answer)
		return
	}
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return
	}
	poll := s.activePolls[id]
	if poll == nil {
		m.mu.Unlock()
		return
	}
	poll.state.LatestEvidence = answer.Evidence
	poll.state.ActiveDispatchID = ""
	state := poll.state
	poll.timer = time.AfterFunc(poll.interval, func() { m.runPollAttempt(key, id) })
	m.mu.Unlock()
	m.emit(key, types.EngineEvent{Type: "engine_poll_progress", PollProgress: &types.PollProgressPayload{Poll: state, Evidence: answer.Evidence}})
	m.emitPollStatus(key, "poll_advancing")
	utils.LogWithFields(utils.LevelInfo, "session.poll", "poll advancing; re-armed", map[string]any{"session_id": key, "poll_id": id, "attempt": state.Attempt, "interval_ms": poll.interval.Milliseconds()})
}

func validPollVerdict(v types.PollVerdict) bool {
	return v == types.PollVerdictSatisfied || v == types.PollVerdictFailed || v == types.PollVerdictAdvancing || v == types.PollVerdictStuck
}

func (m *Manager) finishPoll(key, id string, answer pollChildAnswer) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return
	}
	poll := s.activePolls[id]
	if poll == nil {
		m.mu.Unlock()
		return
	}
	if poll.timer != nil {
		poll.timer.Stop()
	}
	delete(s.activePolls, id)
	result := types.PollTerminalPayload{PollState: poll.state, Verdict: answer.Verdict, Evidence: answer.Evidence, Reason: answer.Reason}
	m.mu.Unlock()
	m.emit(key, types.EngineEvent{Type: "engine_poll_terminal", PollTerminal: &result})
	m.emitPollStatus(key, "poll_terminal")
	payload := fmt.Sprintf("Poll %s (%s).\nIntent: %s\nEvidence:\n%s", id, answer.Verdict, result.Intent, answer.Evidence)
	m.deliverPollResult(key, result, payload)
	utils.LogWithFields(utils.LevelInfo, "session.poll", "poll terminal", map[string]any{"session_id": key, "poll_id": id, "verdict": answer.Verdict, "attempt": result.Attempt})
}

func (m *Manager) deliverPollResult(key string, result types.PollTerminalPayload, payload string) {
	work := types.BackgroundWorkInfo{Kind: string(types.InjectionKindPollResult), DeliveryMode: "wake", Items: []types.BackgroundWorkItem{{ID: result.PollID, Source: types.BackgroundWorkSourcePoll, Label: result.Intent, Status: string(result.Verdict), ElapsedMs: 0}}}

	// A dispatched agent that started this poll and then parked is waiting on
	// it. Poll ownership is session-scoped, so the verdict arrives here rather
	// than at the dispatch -- routing it to the root instead would leave the
	// dispatch (and every ancestor parked on it) blocked on a signal that never
	// comes. Deliver to the owning dispatch and stop: the root learns the
	// outcome through that dispatch's own completion. No parked owner means the
	// root itself is waiting, so the paths below run exactly as before.
	//
	// This mirrors the background-bash wake path (background_task_wake.go),
	// which solved the identical problem for shell tasks.
	m.mu.RLock()
	s := m.sessions[key]
	m.mu.RUnlock()
	if s != nil && s.dispatchRegistry != nil {
		rec := extcontext.PollResultRecord{
			Verdict:  string(result.Verdict),
			Evidence: payload,
		}
		if owner, revived := s.dispatchRegistry.DeliverPollResult(result.PollID, rec); owner != "" {
			utils.LogWithFields(utils.LevelInfo, "session.poll", "poll verdict delivered to parked dispatch", map[string]any{
				"session_id": key, "poll_id": result.PollID, "delivery": "dispatch_revive",
				"dispatch_id": owner, "revived": revived, "verdict": string(result.Verdict),
			})
			return
		}
	}

	outcome := m.SteerAgentWithBackgroundWork(key, "", payload, string(types.InjectionKindPollResult), work)
	if outcome.Delivered() {
		return
	}
	overrides := buildPromptOverrides("", nil, string(types.InjectionKindPollResult))
	overrides.BackgroundWork = work
	if err := m.SendPrompt(key, payload, overrides); err != nil {
		utils.LogWithFields(utils.LevelError, "session.poll", "poll terminal delivery failed", map[string]any{"session_id": key, "poll_id": result.PollID, "error": err.Error()})
		return
	}
	m.emitPromptInjected(key, payload, string(types.InjectionKindPollResult))
}

func (m *Manager) activePollSnapshotLocked(s *engineSession) []types.PollState {
	if len(s.activePolls) == 0 {
		return nil
	}
	out := make([]types.PollState, 0, len(s.activePolls))
	for _, poll := range s.activePolls {
		out = append(out, poll.state)
	}
	return out
}

func (m *Manager) emitPollStatus(key, reason string) { m.emitSessionStatus(key, reason) }

// OutstandingPollIDsFor returns the live polls started by one run: the dispatch
// with this owner ID, or the root session when owner is "".
//
// Scoping by owner is what keeps Poll from deadlocking itself. Poll resolves
// its intent by dispatching a "poll-check" child, and that child is a run in
// the same session. A session-wide reader made the child park on the very poll
// it was dispatched to resolve, so the poll could never finish and every poll
// started inside a dispatch burned its full deadline before returning "stuck".
//
// This mirrors OutstandingChildDispatches, which scopes to a dispatch's own
// children (ChildIDsOf) rather than to every dispatch in the session, and for
// the same reason: a run must park on the work IT is waiting for, never on a
// sibling's work.
func (m *Manager) OutstandingPollIDsFor(key, owner string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	current := m.sessions[key]
	if current == nil {
		return nil
	}
	ids := make([]string, 0, len(current.activePolls))
	for id, poll := range current.activePolls {
		if poll.owner == owner {
			ids = append(ids, id)
		}
	}
	return ids
}
