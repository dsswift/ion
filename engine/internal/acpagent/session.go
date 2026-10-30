package acpagent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Session is one ACP session: an engine session keyed by the id the agent
// minted, with the client-visible state the ACP surface carries.
type Session struct {
	agent *Agent
	id    string
	cwd   string

	mu        sync.Mutex
	profileID string
	model     string
	planMode  bool
	commands  []AvailableCommand
	// mcpServers are the servers the client brought on session/new or
	// session/load, passed to the engine on every open.
	mcpServers map[string]types.McpServerConfig
	// conversationID is the engine conversation the key is bound to, from
	// the last start_session; history loads by it.
	conversationID string
	// tools holds every tool call in flight, by id, with the input streamed
	// for it so far.
	tools map[string]*toolCard
	// dispatches holds every sub-agent dispatch in flight, by dispatch id,
	// with the transcript streamed for it so far.
	dispatches map[string]*dispatchCard
	// turn is the prompt the client is waiting on, nil between prompts.
	turn *turn
	// runEpoch is the last run epoch an engine status reported for this
	// session (StatusFields.RunEpoch); sawEpoch records that one ever did.
	runEpoch int64
	sawEpoch bool
	// released is set when the engine released the session on its own; the
	// next command that needs it reopens it first.
	released bool
	// reopenMu serialises reopening, so concurrent requests open the
	// engine session once.
	reopenMu sync.Mutex
}

// turn is one session/prompt in flight: the loop settles it when the run
// ends, and the prompt handler returns what it settled with.
type turn struct {
	done   chan struct{}
	reason string
	err    error
	// baseline is the session's run epoch when the prompt was sent. An idle
	// status whose epoch has not passed it was built before the engine took
	// the prompt, so it never ends the turn.
	baseline int64
	// command marks a slash command, which may finish without starting a
	// run; started records that a run did start during the turn.
	command bool
	started bool
	// holding is set while the session is idle but the turn stays open:
	// background commands, polls, or agents the engine still waits on
	// will start a further run that belongs to this turn.
	holding bool
	// asks counts the client answers the turn is waiting on (a question
	// card, a plan approval); the turn cannot end while one is open.
	asks int
	// answered records the question tool calls this turn already put to
	// the client, so a repeated status snapshot never asks twice.
	answered map[string]bool
}

// hold records that an idle engine still owes this turn a run.
func (t *turn) hold() { t.holding = true }

// awaiting reports whether a client answer is outstanding.
func (t *turn) awaiting() bool { return t.asks > 0 }

// ask is one client answer a turn waits on. It ends once: when the answer
// continues the turn, or when the asking flow gives up.
type ask struct {
	t    *turn
	once sync.Once
}

// beginAsk opens an ask on the turn. Caller holds s.mu.
func (t *turn) beginAsk() *ask {
	t.asks++
	return &ask{t: t}
}

// endAsk closes the ask when no continuation took it.
func (s *Session) endAsk(a *ask) {
	a.once.Do(func() {
		s.mu.Lock()
		a.t.asks--
		s.mu.Unlock()
	})
}

// sessionKeyPrefix marks engine sessions an ACP agent opened.
const sessionKeyPrefix = "acp-"

func newSessionID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("mint session id: %w", err)
	}
	return sessionKeyPrefix + hex.EncodeToString(b), nil
}

func (a *Agent) sessionNew(params json.RawMessage) (any, *rpcstdio.RPCError) {
	var req NewSessionRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, badParams(err)
	}
	id, err := newSessionID()
	if err != nil {
		return nil, internalError(err)
	}
	s := &Session{agent: a, id: id, cwd: req.Cwd, model: a.opts.Model, mcpServers: mcpServerConfigs(req.McpServers)}
	if p := a.findProfile(a.opts.Profile); p != nil {
		s.profileID = p.ID
	}
	if err := s.start(context.Background(), false); err != nil {
		return nil, internalError(err)
	}
	a.mu.Lock()
	a.sessions[id] = s
	a.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "acp", "session opened", map[string]any{"session_id": id, "cwd": req.Cwd, "profile": s.profileID, "harness": a.opts.harnessName(), "mcp_servers": mcpServerNames(s.mcpServers)})
	return SessionResponse{SessionID: id, Modes: s.modeState(), ConfigOptions: s.configOptions()}, nil
}

func (a *Agent) sessionLoad(params json.RawMessage) (any, *rpcstdio.RPCError) {
	var req LoadSessionRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, badParams(err)
	}
	if !strings.HasPrefix(req.SessionID, sessionKeyPrefix) {
		return nil, fmtErr("session %s was not opened by ion acp", req.SessionID)
	}
	s := &Session{agent: a, id: req.SessionID, cwd: req.Cwd, model: a.opts.Model, mcpServers: mcpServerConfigs(req.McpServers)}
	if p := a.findProfile(a.opts.Profile); p != nil {
		s.profileID = p.ID
	}
	if err := s.start(context.Background(), true); err != nil {
		return nil, internalError(err)
	}
	a.mu.Lock()
	a.sessions[req.SessionID] = s
	a.mu.Unlock()
	if err := s.replayHistory(context.Background()); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "history replay failed", map[string]any{"session_id": s.id, "error": err.Error()})
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "session loaded", map[string]any{"session_id": s.id, "cwd": req.Cwd, "profile": s.profileID, "harness": a.opts.harnessName(), "mcp_servers": mcpServerNames(s.mcpServers)})
	return SessionResponse{Modes: s.modeState(), ConfigOptions: s.configOptions()}, nil
}

// start opens the engine session. With resume set the key's bound
// conversation is reused; otherwise the engine mints a new one.
func (s *Session) start(ctx context.Context, resume bool) error {
	s.agent.engine.Subscribe(s.id)
	if err := s.open(ctx, resume); err != nil {
		s.agent.engine.Unsubscribe(s.id)
		return err
	}
	go s.loop()
	return nil
}

// open sends start_session for the session's key with its current config
// and records the conversation the engine bound the key to.
func (s *Session) open(ctx context.Context, resume bool) error {
	config := map[string]any{"workingDirectory": s.cwd}
	if model := s.effectiveModel(); model != "" {
		config["model"] = model
	}
	s.mu.Lock()
	if len(s.mcpServers) > 0 {
		config["mcpServers"] = s.mcpServers
	}
	if h := s.agent.opts.Harness; h != nil {
		config["extensions"] = []string{h.Path}
	} else if p := s.agent.findProfile(s.profileID); p != nil {
		config["profileId"] = p.ID
		config["extensions"] = p.Extensions
	} else {
		config["extensions"] = []string{}
	}
	if !resume {
		config["forceNewConversation"] = true
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	res, err := s.agent.engine.Send(ctx, map[string]any{"cmd": "start_session", "key": s.id, "config": config})
	if err != nil {
		if str(res, "policyFailure") == types.PolicyFailureAuthenticationFailed {
			return fmt.Errorf("%w: %w", errAuthRequired, err)
		}
		return err
	}
	if data, ok := res["data"].(map[string]any); ok {
		if id := str(data, "conversationId"); id != "" {
			s.mu.Lock()
			s.conversationID = id
			s.mu.Unlock()
		}
	}
	return nil
}

// stop ends the engine session and the client-facing state.
func (s *Session) stop(ctx context.Context) {
	s.cancel()
	ctx, cancelTimeout := context.WithTimeout(ctx, 10*time.Second)
	defer cancelTimeout()
	if _, err := s.agent.engine.Send(ctx, map[string]any{"cmd": "stop_session", "key": s.id}); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "stop_session failed", map[string]any{"session_id": s.id, "error": err.Error()})
	}
	s.agent.engine.Unsubscribe(s.id)
}

// cancel aborts the active run. The run's idle status then ends the prompt
// with the cancelled stop reason. A turn the engine owes no run to (held
// for background work, or waiting on the client's own answer) has no idle
// coming, so it ends here.
func (s *Session) cancel() {
	s.mu.Lock()
	t := s.turn
	settleNow := t != nil && (t.holding || t.awaiting())
	s.mu.Unlock()
	if t == nil {
		return
	}
	if _, err := s.agent.engine.Send(context.Background(), map[string]any{"cmd": "abort", "key": s.id}); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "abort failed", map[string]any{"session_id": s.id, "error": err.Error()})
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "run cancelled by client", map[string]any{"session_id": s.id, "held_turn": settleNow})
	if settleNow {
		s.finishTurn(StopCancelled, nil)
	}
}

// loop consumes the session's engine events for its whole life. Every
// event is translated to the client; the ones that end a run also settle
// the prompt turn waiting on them. One consumer per session means no event
// is ever handed between goroutines.
func (s *Session) loop() {
	q := s.agent.engine.Subscribe(s.id)
	for {
		ev, ok := q.Next(context.Background(), s.agent.engine.Closed())
		if !ok {
			s.finishTurn(StopEndTurn, fmt.Errorf("engine connection closed"))
			return
		}
		s.translate(ev)
	}
}

func (s *Session) modeState() *SessionModeState {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := ModeBuild
	if s.planMode {
		current = ModePlan
	}
	return &SessionModeState{CurrentModeID: current, AvailableModes: []SessionMode{
		{ID: ModeBuild, Name: "Build", Description: "Run tools and change files"},
		{ID: ModePlan, Name: "Plan", Description: "Read-only; write a plan file for approval"},
	}}
}

func (a *Agent) sessionSetMode(params json.RawMessage) (any, *rpcstdio.RPCError) {
	var req SetSessionModeRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, badParams(err)
	}
	s, rpcErr := a.session(req.SessionID)
	if rpcErr != nil {
		return nil, rpcErr
	}
	if err := s.ensureOpen(context.Background()); err != nil {
		return nil, internalError(err)
	}
	var enabled bool
	switch req.ModeID {
	case ModeBuild:
	case ModePlan:
		enabled = true
	default:
		return nil, fmtErr("unknown mode: %s", req.ModeID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := a.engine.Send(ctx, map[string]any{"cmd": "set_plan_mode", "key": s.id, "enabled": enabled}); err != nil {
		return nil, internalError(err)
	}
	s.mu.Lock()
	s.planMode = enabled
	s.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "acp", "mode set", map[string]any{"session_id": s.id, "mode": req.ModeID})
	return map[string]any{}, nil
}
