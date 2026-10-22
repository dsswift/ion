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
	toolInput map[string]*strings.Builder
	// turn is the prompt the client is waiting on, nil between prompts.
	turn *turn
}

// turn is one session/prompt in flight: the loop settles it when the run
// ends, and the prompt handler returns what it settled with.
type turn struct {
	done   chan struct{}
	reason string
	err    error
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
	s := &Session{agent: a, id: id, cwd: req.Cwd, model: a.opts.Model}
	if p := a.findProfile(a.opts.Profile); p != nil {
		s.profileID = p.ID
	}
	if err := s.start(context.Background(), false); err != nil {
		return nil, internalError(err)
	}
	a.mu.Lock()
	a.sessions[id] = s
	a.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "acp", "session opened", map[string]any{"session_id": id, "cwd": req.Cwd, "profile": s.profileID, "harness": a.opts.harnessName(), "mcp_servers_ignored": len(req.McpServers)})
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
	s := &Session{agent: a, id: req.SessionID, cwd: req.Cwd, model: a.opts.Model}
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
	utils.LogWithFields(utils.LevelInfo, "acp", "session loaded", map[string]any{"session_id": s.id, "cwd": req.Cwd, "profile": s.profileID, "harness": a.opts.harnessName()})
	return SessionResponse{Modes: s.modeState(), ConfigOptions: s.configOptions()}, nil
}

// start opens the engine session. With resume set the key's bound
// conversation is reused; otherwise the engine mints a new one.
func (s *Session) start(ctx context.Context, resume bool) error {
	s.agent.engine.Subscribe(s.id)
	config := map[string]any{"workingDirectory": s.cwd}
	if model := s.effectiveModel(); model != "" {
		config["model"] = model
	}
	s.mu.Lock()
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
	if res, err := s.agent.engine.Send(ctx, map[string]any{"cmd": "start_session", "key": s.id, "config": config}); err != nil {
		s.agent.engine.Unsubscribe(s.id)
		if str(res, "policyFailure") == types.PolicyFailureAuthenticationFailed {
			return fmt.Errorf("%w: %w", errAuthRequired, err)
		}
		return err
	}
	go s.loop()
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
// with the cancelled stop reason.
func (s *Session) cancel() {
	s.mu.Lock()
	running := s.turn != nil
	s.mu.Unlock()
	if !running {
		return
	}
	if _, err := s.agent.engine.Send(context.Background(), map[string]any{"cmd": "abort", "key": s.id}); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "abort failed", map[string]any{"session_id": s.id, "error": err.Error()})
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "run cancelled by client", map[string]any{"session_id": s.id})
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
