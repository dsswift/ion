package acpagent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"

	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Options configures an Agent.
type Options struct {
	// Version is the engine build version reported as agentInfo.version.
	Version string
	// Profile is the engine profile (name or id) every new session loads
	// unless the client picks another through the profile config option.
	// Empty loads no extensions.
	Profile string
	// Model is the model every new session starts on. Empty uses the
	// engine's default.
	Model string
	// Profiles is the profile catalog the config option offers.
	Profiles []Profile
	// DefaultModel is the engine's configured default, shown as the model
	// option's current value when the session names none.
	DefaultModel string
}

// Profile is one engine profile the agent can load.
type Profile struct {
	ID         string
	Name       string
	Extensions []string
}

// Agent is one ACP agent process: a JSON-RPC peer over stdio and a
// connection to the engine.
type Agent struct {
	engine *EngineConn
	rpc    *rpcstdio.Client
	opts   Options

	mu       sync.Mutex
	client   ClientCapabilities
	sessions map[string]*Session
	models   []SelectOption
	done     chan struct{}
}

// New builds an Agent over the given stdio pair. out is the pipe the
// client reads (our stdout); in is the pipe the client writes (our stdin).
func New(engine *EngineConn, out io.WriteCloser, in io.Reader, opts Options) *Agent {
	a := &Agent{engine: engine, opts: opts, sessions: map[string]*Session{}, done: make(chan struct{})}
	a.rpc = rpcstdio.NewClient(out, in, rpcstdio.Options{
		Tag:            "acp.agent",
		OnRequest:      a.handleRequest,
		OnNotification: a.handleNotification,
		OnClosed: func(err error) {
			utils.LogWithFields(utils.LevelInfo, "acp", "client connection ended", map[string]any{"error": utils.ErrStr(err)})
			close(a.done)
		},
	})
	return a
}

// Done is closed when the client ends the stdio conversation.
func (a *Agent) Done() <-chan struct{} { return a.done }

// Shutdown stops every session this agent opened. Sessions are stopped,
// not settled: the conversations stay on disk for session/load.
func (a *Agent) Shutdown(ctx context.Context) {
	a.mu.Lock()
	sessions := make([]*Session, 0, len(a.sessions))
	for _, s := range a.sessions {
		sessions = append(sessions, s)
	}
	a.mu.Unlock()
	for _, s := range sessions {
		s.stop(ctx)
	}
}

func (a *Agent) session(id string) (*Session, *rpcstdio.RPCError) {
	a.mu.Lock()
	s, ok := a.sessions[id]
	a.mu.Unlock()
	if !ok {
		return nil, &rpcstdio.RPCError{Code: -32602, Message: "unknown session: " + id}
	}
	return s, nil
}

func (a *Agent) handleNotification(method string, params json.RawMessage) {
	switch method {
	case MethodSessionCancel:
		var req CancelNotification
		if err := json.Unmarshal(params, &req); err != nil {
			utils.LogWithFields(utils.LevelWarn, "acp", "cancel: bad params", map[string]any{"error": err.Error()})
			return
		}
		s, rpcErr := a.session(req.SessionID)
		if rpcErr != nil {
			utils.LogWithFields(utils.LevelWarn, "acp", "cancel: unknown session", map[string]any{"session_id": req.SessionID})
			return
		}
		s.cancel()
	default:
		utils.LogWithFields(utils.LevelDebug, "acp", "notification ignored", map[string]any{"method": method})
	}
}

func (a *Agent) handleRequest(method string, params json.RawMessage) (any, *rpcstdio.RPCError) {
	utils.LogWithFields(utils.LevelDebug, "acp", "request", map[string]any{"method": method})
	switch method {
	case MethodInitialize:
		return a.initialize(params)
	case MethodAuthenticate:
		return map[string]any{}, nil
	case MethodSessionNew:
		return a.sessionNew(params)
	case MethodSessionLoad:
		return a.sessionLoad(params)
	case MethodSessionPrompt:
		return a.sessionPrompt(params)
	case MethodSessionSetMode:
		return a.sessionSetMode(params)
	case MethodSessionSetConfigOption:
		return a.sessionSetConfigOption(params)
	default:
		return nil, &rpcstdio.RPCError{Code: -32601, Message: "method not found: " + method}
	}
}

func (a *Agent) initialize(params json.RawMessage) (any, *rpcstdio.RPCError) {
	var req InitializeRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, badParams(err)
	}
	a.mu.Lock()
	a.client = req.ClientCapabilities
	a.mu.Unlock()
	clientName := ""
	if req.ClientInfo != nil {
		clientName = req.ClientInfo.Name + " " + req.ClientInfo.Version
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "initialized", map[string]any{
		"client": clientName, "client_protocol": req.ProtocolVersion,
		"notices": a.clientSupportsNotices(), "form_elicitation": a.clientSupportsForms(),
	})
	return InitializeResponse{
		ProtocolVersion: ProtocolVersion,
		AgentCapabilities: AgentCapabilities{
			LoadSession:         true,
			PromptCapabilities:  PromptCapabilities{Image: true, EmbeddedContext: true},
			McpCapabilities:     map[string]bool{"http": false, "sse": false},
			SessionCapabilities: map[string]any{},
		},
		AuthMethods: []any{},
		AgentInfo:   Implementation{Name: "ion", Title: "Ion Engine", Version: a.opts.Version},
	}, nil
}

func (a *Agent) clientSupportsNotices() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.client.Session != nil && len(a.client.Session.Notices) > 0 && string(a.client.Session.Notices) != "null"
}

func (a *Agent) clientSupportsForms() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.client.Elicitation != nil && len(a.client.Elicitation.Form) > 0 && string(a.client.Elicitation.Form) != "null"
}

// notify sends one session/update to the client.
func (a *Agent) notify(sessionID string, update SessionUpdate) {
	if err := a.rpc.Notify(NotifSessionUpdate, SessionNotification{SessionID: sessionID, Update: update}); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "session update not delivered", map[string]any{"session_id": sessionID, "update": update.SessionUpdate, "error": err.Error()})
	}
}

func badParams(err error) *rpcstdio.RPCError {
	return &rpcstdio.RPCError{Code: -32602, Message: "invalid params: " + err.Error()}
}

func internalError(err error) *rpcstdio.RPCError {
	return &rpcstdio.RPCError{Code: -32000, Message: err.Error()}
}

func fmtErr(format string, args ...any) *rpcstdio.RPCError {
	return &rpcstdio.RPCError{Code: -32000, Message: fmt.Sprintf(format, args...)}
}
